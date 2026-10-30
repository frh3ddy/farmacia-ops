import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SaleQueue, workerError } from '../queues/sale.queue';
import { AuthGuard, LocationGuard, Roles, RoleGuardedRequest, assertActingAtOwnStore, assertLocationAccess, scopedLocationId } from '../auth/guards/auth.guard';

const PENDING_LINES_LIMIT = 200;

/** Square custom-amount lines waiting to be matched to a product (tasks/sale-accuracy-epic.md). */
@Controller('api/sales/unmatched-lines')
@UseGuards(AuthGuard, LocationGuard)
export class UnmatchedLinesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly saleQueue: SaleQueue,
  ) {}

  /** Newest first; a line whose last match the worker gave up on says why. */
  @Get()
  @Roles('OWNER', 'MANAGER')
  async list(@Req() req: RoleGuardedRequest, @Query('locationId') locationId?: string) {
    const scoped = scopedLocationId(req, locationId);
    if (scoped) assertActingAtOwnStore(req, scoped);
    const lines = await this.prisma.unmatchedSaleLine.findMany({
      where: { matchedSaleItemId: null, ...(scoped && { sale: { locationId: scoped } }) },
      include: { sale: { select: { createdAt: true, location: { select: { id: true, name: true } } } } },
      orderBy: { sale: { createdAt: 'desc' } },
      take: PENDING_LINES_LIMIT,
    });
    const failed = new Map(
      (await this.saleQueue.failedJobs('match-sale-line'))
        .sort((a, b) => (a.finishedOn ?? 0) - (b.finishedOn ?? 0)) // the latest failure per line wins
        .map((j) => [j.data.lineId, { productId: j.data.productId, error: workerError(j.failedReason), failedAt: j.finishedOn ? new Date(j.finishedOn) : null }]),
    );
    const data = lines.map((line) => ({ ...line, matchError: failed.get(line.id) ?? null }));
    return { success: true, data, count: data.length };
  }

  /** The worker takes the stock and cost, so this only queues the match. */
  @Post(':id/match')
  @Roles('OWNER', 'MANAGER')
  @HttpCode(202)
  async match(@Req() req: RoleGuardedRequest, @Param('id') id: string, @Body() body: { productId?: string }) {
    const line = await this.prisma.unmatchedSaleLine.findUnique({ where: { id }, include: { sale: true } });
    if (!line) throw new NotFoundException('Línea de venta no encontrada');
    assertLocationAccess(req, line.sale.locationId);
    assertActingAtOwnStore(req, line.sale.locationId);
    if (line.matchedSaleItemId) throw new ConflictException('Esta línea ya está asignada a un producto');

    const product = body?.productId ? await this.prisma.product.findUnique({ where: { id: body.productId } }) : null;
    if (!product) throw new BadRequestException('Elige un producto');
    if (!product.tracksInventory) throw new BadRequestException(`${product.name} no tiene existencias`);
    if (product.isDiscontinued) throw new BadRequestException(`${product.name} está descontinuado`);
    if (product.soldOnlyAtLocationId && product.soldOnlyAtLocationId !== line.sale.locationId) {
      throw new BadRequestException(`${product.name} no se vende en esta sucursal`);
    }

    await this.saleQueue.enqueueMatch({ lineId: line.id, productId: product.id, matchedBy: req.employee.id });
    return { success: true, queued: true };
  }
}
