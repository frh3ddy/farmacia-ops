import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SaleQueue } from '../queues/sale.queue';
import { AuthGuard, LocationGuard, Roles, RoleGuardedRequest, assertLocationAccess, scopedLocationId } from '../auth/guards/auth.guard';

const DAY_MS = 24 * 60 * 60 * 1000;

type ReturnBody = { items?: Array<{ saleItemId: string; quantity: number }>; reason?: string; clientRequestId?: string };

/**
 * Customer returns made by hand (tasks/sale-accuracy-epic.md). Any till employee
 * may return at their location — the owner decided no PIN; the returns list is the control.
 */
@Controller('api/sales')
@UseGuards(AuthGuard, LocationGuard)
export class SaleReturnsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly saleQueue: SaleQueue,
  ) {}

  /** Recent sales to return from, with what is left of each item. */
  @Get('recent')
  @Roles('OWNER') // staff return in Square; by hand is the owner's fallback
  async recent(@Req() req: RoleGuardedRequest, @Query('locationId') locationId?: string, @Query('days') days?: string) {
    const scoped = scopedLocationId(req, locationId);
    const since = new Date(Date.now() - Math.min(Number(days) || 3, 14) * DAY_MS);
    const sales = await this.prisma.sale.findMany({
      where: { createdAt: { gte: since }, ...(scoped && { locationId: scoped }) },
      include: {
        location: { select: { name: true } },
        items: { include: { product: { select: { name: true } }, returns: { select: { quantity: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: sales };
  }

  /** The worker restocks and updates the sale, so this only queues the return. */
  @Post(':saleId/returns')
  @Roles('OWNER') // staff return in Square; by hand is the owner's fallback
  @HttpCode(202)
  async record(@Req() req: RoleGuardedRequest, @Param('saleId') saleId: string, @Body() body: ReturnBody) {
    const sale = await this.prisma.sale.findUnique({ where: { id: saleId }, include: { items: { include: { returns: true } } } });
    if (!sale) throw new NotFoundException('Sale not found');
    assertLocationAccess(req, sale.locationId);
    if (!body?.clientRequestId) throw new BadRequestException('clientRequestId is required');
    const items = body.items ?? [];
    if (items.length === 0) throw new BadRequestException('Choose at least one item to return');

    for (const { saleItemId, quantity } of items) {
      const item = sale.items.find((i) => i.id === saleItemId);
      const left = item ? item.quantity - item.returns.reduce((n, r) => n + r.quantity, 0) : 0;
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > left) {
        throw new BadRequestException(`Only ${left} left to return for item ${saleItemId}`);
      }
    }

    await this.saleQueue.enqueueReturn({ saleId, items, reason: body.reason, returnedBy: req.employee.id, clientRequestId: body.clientRequestId });
    return { success: true, queued: true };
  }

  /** Every return, newest first, with who made it. */
  @Get('returns')
  @Roles('OWNER', 'MANAGER')
  async list(@Req() req: RoleGuardedRequest, @Query('locationId') locationId?: string) {
    const scoped = scopedLocationId(req, locationId);
    const returns = await this.prisma.saleReturn.findMany({
      where: scoped ? { sale: { locationId: scoped } } : {},
      include: {
        sale: { select: { createdAt: true, location: { select: { name: true } } } },
        items: { include: { saleItem: { select: { product: { select: { name: true } } } }, adjustment: { select: { squareSynced: true, squareSyncError: true } } } },
      },
      orderBy: { returnedAt: 'desc' },
      take: 200,
    });
    const ids = [...new Set(returns.map((r) => r.returnedBy).filter((id): id is string => !!id))];
    const names = new Map((await this.prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
    return { success: true, data: returns.map((r) => ({ ...r, returnedByName: r.returnedBy ? names.get(r.returnedBy) ?? null : null })) };
  }
}
