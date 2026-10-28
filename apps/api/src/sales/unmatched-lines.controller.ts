import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SaleQueue } from '../queues/sale.queue';
import { AuthGuard, LocationGuard, Roles, RoleGuardedRequest, assertLocationAccess, scopedLocationId } from '../auth/guards/auth.guard';

/** Square custom-amount lines waiting to be matched to a product (tasks/sale-accuracy-epic.md). */
@Controller('api/sales/unmatched-lines')
@UseGuards(AuthGuard, LocationGuard)
export class UnmatchedLinesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly saleQueue: SaleQueue,
  ) {}

  @Get()
  @Roles('OWNER', 'MANAGER')
  async list(@Req() req: RoleGuardedRequest, @Query('locationId') locationId?: string) {
    const scoped = scopedLocationId(req, locationId);
    const lines = await this.prisma.unmatchedSaleLine.findMany({
      where: { matchedSaleItemId: null, ...(scoped && { sale: { locationId: scoped } }) },
      include: { sale: { select: { createdAt: true, location: { select: { id: true, name: true } } } } },
      orderBy: { sale: { createdAt: 'desc' } },
    });
    return { success: true, data: lines, count: lines.length };
  }

  /** The worker takes the stock and cost, so this only queues the match. */
  @Post(':id/match')
  @Roles('OWNER', 'MANAGER')
  @HttpCode(202)
  async match(@Req() req: RoleGuardedRequest, @Param('id') id: string, @Body() body: { productId?: string }) {
    const line = await this.prisma.unmatchedSaleLine.findUnique({ where: { id }, include: { sale: true } });
    if (!line) throw new NotFoundException('Sale line not found');
    assertLocationAccess(req, line.sale.locationId);
    if (line.matchedSaleItemId) throw new ConflictException('Esta línea ya está asignada a un producto');

    const product = body?.productId ? await this.prisma.product.findUnique({ where: { id: body.productId } }) : null;
    if (!product) throw new BadRequestException('Elige un producto');
    if (!product.tracksInventory) throw new BadRequestException(`${product.name} no tiene existencias`);

    await this.saleQueue.enqueueMatch({ lineId: line.id, productId: product.id, matchedBy: req.employee.id });
    return { success: true, queued: true };
  }
}
