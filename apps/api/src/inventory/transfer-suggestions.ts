import { Prisma, type PrismaClient } from '@prisma/client';
import { daysUntilExpiry, expiryDayStart } from './business-date';

/** One row of GET /transfers/suggestions. */
export interface TransferSuggestion {
  product: { id: string; name: string };
  toLocationId: string;
  suggested: number;
  /** Before the cap for a first lot out that expires within 60 days. */
  originalSuggested?: number;
  destSellable: number;
  destExpired: number;
  destRatePerWeek: number;
  originSellable: number;
  /** The origin's sellable stock after this and the suggestions before it for the same product. */
  originAfter: number;
  /** Days until the origin's first lot out expires, when that's within 60. */
  firstLotDaysToExpiry?: number;
  /** The origin's first lot out is expired: a transfer would send it, so record the merma first. */
  blocked?: { reason: 'EXPIRED_FIRST'; expiredUnits: number };
}

export type TransferSkipReason = 'NOT_TRACKED' | 'SOLD_AT_ONE_STORE' | 'DISCONTINUED' | 'PAUSED_AT_DESTINATION' | 'NO_STATS_AT_DESTINATION';
export interface TransferSkip { product: { id: string; name: string }; toLocationId: string | null; reason: TransferSkipReason }

const EXPIRY_CAP_DAYS = 60;

/**
 * What a store can send to the others, computed on request from live stock,
 * lots, units in transit and last night's ProductStockStats. Nothing is stored.
 *
 * Sellable stock leaves out lots past their expiry day (as the stock alerts).
 * - need at a store = max(⌈coverDays × rate⌉, typicalOnHand) − sellable − in transit to it
 * - spare at the origin = sellable − ⌈coverDays × rate⌉ (its own settings and rate)
 * The spare goes to the stores losing the most sales first (highest rate); a
 * store that sells none of it gets none. A transfer takes the origin's oldest
 * lot first, expired or not, so: an expired first lot blocks the row (merma
 * first); one expiring within 60 days caps each store at what it sells by then.
 *
 * Products: the origin's with something to spare, or those in productIds.
 * Skipped with a reason: not tracked, sold at one store, discontinued (once per
 * product); paused at a store, or no stats there (per store, only when the
 * origin has some to spare).
 * ponytail: the 60-day cap assumes the whole suggestion comes from the first lot.
 */
export async function transferSuggestions(
  prisma: PrismaClient,
  o: { fromLocationId: string; toLocationId?: string; productIds?: string[]; now?: Date },
): Promise<{ suggestions: TransferSuggestion[]; skipped: TransferSkip[] }> {
  const now = o.now ?? new Date();
  const origin = o.fromLocationId;
  const dests = await prisma.location.findMany({
    where: { isActive: true, id: o.toLocationId ? { equals: o.toLocationId, not: origin } : { not: origin } },
    select: { id: true },
  });
  if (!dests.length || (o.productIds && !o.productIds.length)) return { suggestions: [], skipped: [] };
  const destIds = dests.map((d) => d.id);
  const stores = [origin, ...destIds];
  const expiredBefore = expiryDayStart(1, now);

  const rows = await prisma.$queryRaw<Array<{
    id: string; name: string; tracks: boolean; sold_only_at: string | null; discontinued: boolean;
    location_id: string; sellable: number; expired: number; rate: number | null; typical: number | null; cover: number;
    paused: boolean; in_transit: number; first_expiry: Date | null;
  }>>`
    WITH inv AS (
      SELECT "productId", "locationId",
             COALESCE(SUM(quantity) FILTER (WHERE NOT expired), 0)::int AS sellable,
             COALESCE(SUM(quantity) FILTER (WHERE expired), 0)::int AS expired
        FROM (SELECT *, COALESCE("expiryDate" < ${expiredBefore}, false) AS expired FROM "Inventory"
               WHERE quantity > 0 AND "locationId" IN (${Prisma.join(stores)})) i
       GROUP BY 1, 2
    ),
    products AS (
      SELECT p.id, p.name, p."tracksInventory" AS tracks, p."soldOnlyAtLocationId" AS sold_only_at, p."isDiscontinued" AS discontinued
        FROM "Product" p
       WHERE ${o.productIds
         ? Prisma.sql`p.id IN (${Prisma.join(o.productIds)})`
         : Prisma.sql`EXISTS (SELECT 1 FROM inv WHERE inv."productId" = p.id AND inv."locationId" = ${origin} AND inv.sellable > 0)`}
    ),
    first_lot AS (
      SELECT DISTINCT ON ("productId") "productId", "expiryDate"
        FROM "Inventory"
       WHERE "locationId" = ${origin} AND quantity > 0 AND "productId" IN (SELECT id FROM products)
       ORDER BY "productId", "receivedAt", id
    ),
    in_transit AS (
      SELECT "productId", "toLocationId", SUM(quantity)::int AS units
        FROM "Transfer" WHERE status = 'IN_TRANSIT' AND "productId" IN (SELECT id FROM products)
       GROUP BY 1, 2
    )
    SELECT p.*, l.id AS location_id,
           COALESCE(inv.sellable, 0) AS sellable, COALESCE(inv.expired, 0) AS expired,
           st."unitsSold"::float8 / NULLIF(st."windowDays", 0) AS rate, st."typicalOnHand" AS typical,
           COALESCE(cfg."coverDays", 14) AS cover,
           ps."productId" IS NOT NULL AS paused,
           COALESCE(t.units, 0) AS in_transit,
           f."expiryDate" AS first_expiry
      FROM products p
      CROSS JOIN (SELECT unnest(ARRAY[${Prisma.join(stores)}]::text[]) AS id) l
      LEFT JOIN inv ON inv."productId" = p.id AND inv."locationId" = l.id
      LEFT JOIN "ProductStockStats" st ON st."productId" = p.id AND st."locationId" = l.id
      LEFT JOIN "StockAlertSettings" cfg ON cfg."locationId" = l.id
      LEFT JOIN "ProductStoreStatus" ps ON ps."productId" = p.id AND ps."locationId" = l.id AND ps."pausedAt" IS NOT NULL
      LEFT JOIN in_transit t ON t."productId" = p.id AND t."toLocationId" = l.id
      LEFT JOIN first_lot f ON f."productId" = p.id
     ORDER BY p.name, p.id`;

  const byProduct = new Map<string, typeof rows>();
  for (const r of rows) byProduct.set(r.id, [...(byProduct.get(r.id) ?? []), r]);

  const suggestions: TransferSuggestion[] = [];
  const skipped: TransferSkip[] = [];
  for (const at of byProduct.values()) {
    const here = at.find((r) => r.location_id === origin)!;
    const product = { id: here.id, name: here.name };
    const productSkip: TransferSkipReason | null = !here.tracks ? 'NOT_TRACKED' : here.sold_only_at ? 'SOLD_AT_ONE_STORE' : here.discontinued ? 'DISCONTINUED' : null;
    if (productSkip) {
      skipped.push({ product, toLocationId: null, reason: productSkip });
      continue;
    }
    let spare = here.sellable - Math.ceil(here.cover * (here.rate ?? 0));
    if (spare <= 0) continue;
    let originAfter = here.sellable;

    const daysToExpiry = here.first_expiry ? daysUntilExpiry(here.first_expiry, now) : null;
    const blocked = daysToExpiry !== null && daysToExpiry <= 0 ? { reason: 'EXPIRED_FIRST' as const, expiredUnits: here.expired } : undefined;
    const expiresSoon = daysToExpiry !== null && daysToExpiry > 0 && daysToExpiry <= EXPIRY_CAP_DAYS;

    const needing = [];
    for (const d of at.filter((r) => r.location_id !== origin)) {
      if (d.paused) skipped.push({ product, toLocationId: d.location_id, reason: 'PAUSED_AT_DESTINATION' });
      else if (d.rate === null) skipped.push({ product, toLocationId: d.location_id, reason: 'NO_STATS_AT_DESTINATION' });
      else if (d.rate > 0) {
        const need = Math.max(Math.ceil(d.cover * d.rate), d.typical ?? 0) - d.sellable - d.in_transit;
        if (need > 0) needing.push({ d, rate: d.rate, need });
      }
    }
    needing.sort((a, b) => b.rate - a.rate || a.d.location_id.localeCompare(b.d.location_id));
    for (const { d, rate, need } of needing) {
      if (spare <= 0) break;
      const wanted = Math.min(need, spare);
      const suggested = expiresSoon ? Math.min(wanted, Math.floor(rate * daysToExpiry!)) : wanted;
      spare -= suggested;
      originAfter -= suggested;
      suggestions.push({
        product,
        toLocationId: d.location_id,
        suggested,
        ...(suggested < wanted && { originalSuggested: wanted }),
        destSellable: d.sellable,
        destExpired: d.expired,
        destRatePerWeek: Math.round(rate * 7 * 10) / 10,
        originSellable: here.sellable,
        originAfter,
        ...(expiresSoon && { firstLotDaysToExpiry: daysToExpiry! }),
        ...(blocked && { blocked }),
      });
    }
  }
  // The stores losing the most sales first.
  suggestions.sort((a, b) => b.destRatePerWeek - a.destRatePerWeek || a.product.name.localeCompare(b.product.name) || a.toLocationId.localeCompare(b.toLocationId));
  return { suggestions, skipped };
}
