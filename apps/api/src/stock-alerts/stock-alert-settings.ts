import { BadRequestException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

/** Each number setting and the range it may take. */
const RANGES = {
  windowDays: [28, 365],
  coverDays: [1, 120],
  regularMinWeeks: [1, 52],
  slowMaxUnits: [0, 100],
  slowMinDaysAtZero: [1, 365],
  equivalentMinUnits: [1, 100],
  noSalesMinDays: [30, 730],
  lowMarginPct: [1, 60],
} as const;
type NumberSetting = keyof typeof RANGES;

export type StockAlertSettingsPatch = Partial<Record<NumberSetting, number>> & { receivingLocationId?: string | null; receivingReviewed?: true };

/**
 * A store's stock alert settings (defaults when it has no row), the store its
 * supplier orders go through (null: it buys for itself), and the active stores
 * that buy through it (a closed one is never ordered for).
 */
export async function stockAlertSettingsOf(prisma: PrismaClient, locationId: string) {
  const [row, supplied] = await Promise.all([
    prisma.stockAlertSettings.findUnique({ where: { locationId } }),
    prisma.stockAlertSettings.findMany({ where: { receivingLocationId: locationId, location: { isActive: true } }, select: { locationId: true }, orderBy: { locationId: 'asc' } }),
  ]);
  const s = row ?? { windowDays: 90, coverDays: 14, regularMinWeeks: 4, slowMaxUnits: 2, slowMinDaysAtZero: 30, equivalentMinUnits: 3, noSalesMinDays: 180, lowMarginPct: 20, receivingLocationId: null };
  return {
    locationId,
    windowDays: s.windowDays,
    coverDays: s.coverDays,
    regularMinWeeks: s.regularMinWeeks,
    slowMaxUnits: s.slowMaxUnits,
    slowMinDaysAtZero: s.slowMinDaysAtZero,
    equivalentMinUnits: s.equivalentMinUnits,
    noSalesMinDays: s.noSalesMinDays,
    lowMarginPct: s.lowMarginPct,
    receivingLocationId: s.receivingLocationId,
    suppliesLocationIds: supplied.map((r) => r.locationId),
    receivingReviewed: await reviewedOf(prisma, row),
  };
}

/** Who confirmed who receives from suppliers, and when; null until someone does. */
async function reviewedOf(prisma: PrismaClient, row: { receivingReviewedAt: Date | null; receivingReviewedBy: string | null } | null) {
  if (!row?.receivingReviewedAt) return null;
  const by = row.receivingReviewedBy ? await prisma.employee.findUnique({ where: { id: row.receivingReviewedBy }, select: { id: true, name: true } }) : null;
  return { at: row.receivingReviewedAt, by };
}

/**
 * Changes a store's settings; fields not sent are kept. A receiving store
 * buys for itself (one level only: no chains). Changing what the alert reads
 * re-sends the store's products to the phones (DB trigger). Confirming
 * (`receivingReviewed: true`) or sending `receivingLocationId` marks who
 * receives as reviewed by `by` in every open store: it's one business-wide choice.
 */
export async function updateStockAlertSettings(prisma: PrismaClient, locationId: string, patch: StockAlertSettingsPatch, by?: string) {
  if (patch?.receivingReviewed !== undefined && patch.receivingReviewed !== true) throw new BadRequestException('receivingReviewed solo puede ser true');
  const data: StockAlertSettingsPatch = {};
  for (const key of Object.keys(RANGES) as NumberSetting[]) {
    const value = patch?.[key];
    if (value === undefined) continue;
    const [min, max] = RANGES[key];
    if (!Number.isInteger(value) || value < min || value > max) throw new BadRequestException(`${key} debe ser un número entero entre ${min} y ${max}`);
    data[key] = value;
  }
  if (patch?.receivingLocationId !== undefined) {
    const to = patch.receivingLocationId;
    if (to !== null) {
      if (typeof to !== 'string' || !to) throw new BadRequestException('Sucursal no válida');
      if (to === locationId) throw new BadRequestException('Una sucursal no puede recibir por sí misma');
      const target = await prisma.location.findUnique({ where: { id: to }, select: { isActive: true, stockAlertSettings: { select: { receivingLocationId: true } } } });
      if (!target?.isActive) throw new BadRequestException('Sucursal no encontrada');
      if (target.stockAlertSettings?.receivingLocationId) throw new BadRequestException('Esa sucursal compra a través de otra');
      if (await prisma.stockAlertSettings.count({ where: { receivingLocationId: locationId } })) throw new BadRequestException('Otras sucursales compran a través de esta');
    }
    data.receivingLocationId = to;
  }
  await prisma.stockAlertSettings.upsert({ where: { locationId }, create: { locationId, ...data }, update: data });
  if (patch?.receivingReviewed || patch?.receivingLocationId !== undefined) {
    const mark = { receivingReviewedAt: new Date(), receivingReviewedBy: by ?? null };
    const open = await prisma.location.findMany({ where: { isActive: true }, select: { id: true } });
    await prisma.$transaction(open.map(({ id }) => prisma.stockAlertSettings.upsert({ where: { locationId: id }, create: { locationId: id, ...mark }, update: mark })));
  }
  return stockAlertSettingsOf(prisma, locationId);
}
