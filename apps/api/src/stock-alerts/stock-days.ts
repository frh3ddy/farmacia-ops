import { PrismaClient } from '@prisma/client';
import { businessDay, parseBusinessDate } from '../inventory/business-date';
import type { StockDayRow } from './stock-history';

const DAY = 86_400_000;

/**
 * A store's end-of-day stock per product from `from` (a store day) to today,
 * from the app's own movements: walked back from what is on hand now. Units
 * come in as batches, whatever created them (receivings and received transfers
 * are restocks; found, returned or broken-bulk units, a new product's initial
 * stock and cutover opening stock aren't) and go out as consumptions.
 * A consumption is dated when it was recorded (consumedAt), so a sale the
 * worker records after midnight counts on that day, not the day it was rung up;
 * levels stay right, only the day of a late sale shifts. Lot
 * pieces only move units between batches, so they aren't movements. Each
 * product gets a row for `from`, then one per day it moved.
 */
export async function appStockDays(prisma: PrismaClient, locationId: string, from: string): Promise<Map<string, StockDayRow[]>> {
  const start = parseBusinessDate(from, 'start');
  const onHand = await prisma.$queryRaw<Array<{ productId: string; quantity: number }>>`
    SELECT "productId", sum(quantity)::int AS quantity FROM "Inventory" WHERE "locationId" = ${locationId} GROUP BY 1`;
  const moves = await prisma.$queryRaw<Array<{ productId: string; at: Date; quantity: number; restock: boolean }>>`
    SELECT i."productId", i."createdAt" AS at,
           -- what the batch started with: Inventory keeps no initial quantity, so add back what left it
           (i.quantity + i."splitOut" + coalesce((SELECT sum(c.quantity) FROM "InventoryConsumption" c WHERE c."inventoryId" = i.id), 0))::int AS quantity,
           (EXISTS (SELECT 1 FROM "InventoryReceiving" r WHERE r."inventoryBatchId" = i.id)
             OR EXISTS (SELECT 1 FROM "TransferLine" tl WHERE tl."destinationInventoryId" = i.id)) AS restock
      FROM "Inventory" i
     WHERE i."locationId" = ${locationId} AND i."createdAt" >= ${start} AND i."splitFromId" IS NULL
    UNION ALL
    SELECT i."productId", c."consumedAt", -c.quantity, false
      FROM "InventoryConsumption" c JOIN "Inventory" i ON i.id = c."inventoryId"
     WHERE i."locationId" = ${locationId} AND c."consumedAt" >= ${start}`;

  // Per product: day → [net units, restocked].
  const byProduct = new Map<string, Map<string, [number, boolean]>>();
  for (const m of moves) {
    const days = byProduct.get(m.productId) ?? new Map<string, [number, boolean]>();
    const day = businessDay(m.at);
    const [net, restocked] = days.get(day) ?? [0, false];
    days.set(day, [net + m.quantity, restocked || m.restock]);
    byProduct.set(m.productId, days);
  }
  const level = new Map(onHand.map((r) => [r.productId, r.quantity]));
  const result = new Map<string, StockDayRow[]>();
  for (const productId of new Set([...level.keys(), ...byProduct.keys()])) {
    const days = byProduct.get(productId) ?? new Map<string, [number, boolean]>();
    const later = [...days].filter(([d]) => d > from).sort(([a], [b]) => a.localeCompare(b));
    let quantity = (level.get(productId) ?? 0) - later.reduce((s, [, [net]]) => s + net, 0);
    const rows: StockDayRow[] = [{ day: from, quantity, restocked: days.get(from)?.[1] ?? false }];
    for (const [day, [net, restocked]] of later) rows.push({ day, quantity: (quantity += net), restocked });
    result.set(productId, rows);
  }
  return result;
}

/** Rows that say something new after `last` (the row stored before them): a different level, or a restock. */
export function changedRows(last: { quantity: number } | undefined, rows: StockDayRow[]): StockDayRow[] {
  let previous = last?.quantity ?? 0;
  return rows.filter((r) => {
    const keep = r.restocked || r.quantity !== previous;
    previous = r.quantity;
    return keep;
  });
}

/** The latest stored row before `day`, per product, at a store. */
async function lastRows(prisma: PrismaClient, locationId: string, day: string) {
  const rows = await prisma.$queryRaw<Array<{ productId: string; quantity: number }>>`
    SELECT DISTINCT ON ("productId") "productId", quantity FROM "StockDay"
     WHERE "locationId" = ${locationId} AND day < ${day}::date ORDER BY "productId", day DESC`;
  return new Map(rows.map((r) => [r.productId, r]));
}

/**
 * The day after a store's last stored day, or `yesterday` when nothing is stored or it's already reached.
 * ponytail: rows exist only on days something changed, so at an active store where nothing moves (closed but
 * still active) this start drifts back and each night recomputes every day since. Still correct, just more
 * work per night. Store a per-store "recorded through" day if that ever gets slow.
 */
async function firstMissingDay(prisma: PrismaClient, locationId: string, yesterday: string): Promise<string> {
  const { _max } = await prisma.stockDay.aggregate({ where: { locationId }, _max: { day: true } });
  if (!_max.day) return yesterday;
  const next = businessDay(new Date(_max.day.getTime() + DAY + 12 * 3_600_000)); // noon UTC: the stored date, not the clock's
  return next < yesterday ? next : yesterday;
}

/**
 * Nightly, after midnight on the store clock: stores each active store's
 * end-of-day stock for every day since its last stored day up to yesterday
 * (so a night the job didn't run, or the gap after the import, is filled),
 * for products whose level changed or that were restocked. A rerun the same
 * night rewrites the same rows.
 */
export async function recordStockDays(prisma: PrismaClient, now = new Date()): Promise<number> {
  const yesterday = businessDay(new Date(now.getTime() - DAY));
  const locations = await prisma.location.findMany({ where: { isActive: true }, select: { id: true } });
  let saved = 0;
  for (const { id: locationId } of locations) {
    const from = await firstMissingDay(prisma, locationId, yesterday);
    const days = await appStockDays(prisma, locationId, from);
    const last = await lastRows(prisma, locationId, from);
    const rows = [...days].flatMap(([productId, r]) =>
      changedRows(last.get(productId), r.filter((x) => x.day <= yesterday)).map((x) => ({ productId, locationId, day: new Date(x.day), quantity: x.quantity, restocked: x.restocked })),
    );
    await prisma.$transaction([
      prisma.stockDay.deleteMany({ where: { locationId, day: { gte: new Date(from), lte: new Date(yesterday) } } }),
      prisma.stockDay.createMany({ data: rows }),
    ]);
    saved += rows.length;
  }
  return saved;
}
