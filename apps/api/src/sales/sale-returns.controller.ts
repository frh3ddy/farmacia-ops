import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SaleQueue, workerError } from '../queues/sale.queue';
import { AuthGuard, LocationGuard, Roles, RoleGuardedRequest, assertActingAtOwnStore, assertLocationAccess, scopedLocationId } from '../auth/guards/auth.guard';
import { businessDay, parseBusinessDate } from '../inventory/business-date';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_SALES_LIMIT = 200;
const RETURNS_LIMIT = 200;
const CASH_DAYS = 31;
const REASON_MAX_LENGTH = 500;

type ReturnBody = { items?: Array<{ saleItemId: string; quantity: number }>; reason?: string; clientRequestId?: string };

/**
 * Customer returns made by hand (tasks/sale-returns-epic.md): the owner's fallback
 * when a return can't be made in Square. They are paid back in cash, so the
 * history totals that cash per day and store.
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
    const lookBack = Number(days) > 0 ? Math.min(Number(days), 14) : 3;
    const since = new Date(Date.now() - lookBack * DAY_MS);
    const sales = await this.prisma.sale.findMany({
      where: { createdAt: { gte: since }, ...(scoped && { locationId: scoped }) },
      include: {
        location: { select: { name: true } },
        items: { include: { product: { select: { name: true } }, returns: { select: { quantity: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: RECENT_SALES_LIMIT,
    });
    return { success: true, data: sales };
  }

  /** The worker restocks and records the return, so this only queues it. */
  @Post(':saleId/returns')
  @Roles('OWNER') // staff return in Square; by hand is the owner's fallback
  @HttpCode(202)
  async record(@Req() req: RoleGuardedRequest, @Param('saleId') saleId: string, @Body() body: ReturnBody) {
    const sale = await this.prisma.sale.findUnique({
      where: { id: saleId },
      include: { items: { include: { returns: true, product: { select: { name: true } } } } },
    });
    if (!sale) throw new NotFoundException('Venta no encontrada');
    assertLocationAccess(req, sale.locationId);
    if (typeof body?.clientRequestId !== 'string' || !body.clientRequestId) throw new BadRequestException('clientRequestId is required');
    if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > REASON_MAX_LENGTH)) {
      throw new BadRequestException(`El motivo debe ser texto de hasta ${REASON_MAX_LENGTH} caracteres`);
    }
    const items = body.items ?? [];
    if (items.length === 0) throw new BadRequestException('Elige al menos un artículo para devolver');

    // One request can list an item twice: check what it takes back in total (the worker checks again).
    const requested = new Map<string, number>();
    for (const { saleItemId, quantity } of items) {
      const item = sale.items.find((i) => i.id === saleItemId);
      if (!item) throw new BadRequestException('Ese artículo no es de esta venta');
      const total = (requested.get(saleItemId) ?? 0) + quantity;
      const left = item.quantity - item.returns.reduce((n, r) => n + r.quantity, 0);
      if (!Number.isInteger(quantity) || quantity <= 0 || total > left) {
        throw new BadRequestException(`Solo quedan ${left} de ${item.product.name} por devolver`);
      }
      requested.set(saleItemId, total);
    }

    await this.saleQueue.enqueueReturn({ saleId, items, reason: body.reason, returnedBy: req.employee.id, clientRequestId: body.clientRequestId });
    return { success: true, queued: true };
  }

  /**
   * Every return, newest first, with who made it; the cash returns by hand paid
   * back per day and store; and returns the worker gave up on, which were never recorded.
   */
  @Get('returns')
  @Roles('OWNER', 'MANAGER')
  async list(@Req() req: RoleGuardedRequest, @Query('locationId') locationId?: string) {
    const scoped = scopedLocationId(req, locationId);
    if (scoped) assertActingAtOwnStore(req, scoped);
    const returns = await this.prisma.saleReturn.findMany({
      where: scoped ? { sale: { locationId: scoped } } : {},
      include: {
        sale: { select: { createdAt: true, location: { select: { name: true } } } },
        items: { include: { saleItem: { select: { product: { select: { name: true } } } }, adjustment: { select: { squareSynced: true, squareSyncError: true } } } },
      },
      orderBy: { returnedAt: 'desc' },
      take: RETURNS_LIMIT,
    });
    const ids = [...new Set(returns.map((r) => r.returnedBy).filter((id): id is string => !!id))];
    const names = new Map((await this.prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
    return {
      success: true,
      data: returns.map((r) => ({ ...r, returnedByName: r.returnedBy ? names.get(r.returnedBy) ?? null : null })),
      cashByDay: await this.cashByDay(scoped),
      failed: await this.failedReturns(scoped),
    };
  }

  private async cashByDay(locationId: string | undefined) {
    // Whole days: from the start of the oldest one.
    const since = parseBusinessDate(businessDay(new Date(Date.now() - CASH_DAYS * DAY_MS)), 'start');
    const handReturns = await this.prisma.saleReturn.findMany({
      where: { cashRefunded: { not: null }, returnedAt: { gte: since }, ...(locationId && { sale: { locationId } }) },
      select: { returnedAt: true, cashRefunded: true, sale: { select: { location: { select: { id: true, name: true } } } } },
    });
    const totals = new Map<string, { day: string; location: string; cash: Prisma.Decimal }>();
    for (const r of handReturns) {
      const day = businessDay(r.returnedAt);
      const key = `${day}|${r.sale.location.id}`;
      const total = totals.get(key) ?? { day, location: r.sale.location.name, cash: new Prisma.Decimal(0) };
      totals.set(key, { ...total, cash: total.cash.add(r.cashRefunded!) });
    }
    return [...totals.values()]
      .sort((a, b) => b.day.localeCompare(a.day) || a.location.localeCompare(b.location))
      .map((t) => ({ ...t, cash: t.cash.toString() }));
  }

  /**
   * Returns queued here that the worker refused or couldn't save. One it saved
   * but couldn't push to Square is in the history already, with its Square error.
   */
  private async failedReturns(locationId: string | undefined) {
    const jobs = await this.saleQueue.failedJobs('record-return');
    if (jobs.length === 0) return [];
    const recorded = new Set(
      (await this.prisma.saleReturn.findMany({ where: { clientRequestId: { in: jobs.map((j) => j.data.clientRequestId) } }, select: { clientRequestId: true } }))
        .map((r) => r.clientRequestId),
    );
    const sales = locationId ? new Set((await this.prisma.sale.findMany({ where: { id: { in: jobs.map((j) => j.data.saleId) }, locationId }, select: { id: true } })).map((s) => s.id)) : null;
    return jobs
      .filter((j) => !recorded.has(j.data.clientRequestId) && (!sales || sales.has(j.data.saleId)))
      .map((j) => ({ jobId: j.id, saleId: j.data.saleId, items: j.data.items, reason: j.data.reason, error: workerError(j.failedReason), failedAt: j.finishedOn ? new Date(j.finishedOn) : null }));
  }
}
