import { BadRequestException } from '@nestjs/common';
import type { PauseSuggestionKind, PrismaClient } from '@prisma/client';
import type { GuardedRequest } from '../auth/guards/auth.guard';
import { catalogRowsSql } from '../products/products.service';
import { salesLines } from '../sales-history/sales-history';

/** One row of GET /inventory/pause-suggestions, the shape FarmaciaKit's PauseSuggestion decodes. */
export interface PauseSuggestion {
  product: { id: string; name: string };
  kind: PauseSuggestionKind;
  lastSoldAt: string | null;
  unitsInWindow: number;
  daysAtZero: number;
  stockOuts: number;
  equivalent: { id: string; name: string; unitsSince: number } | null;
}

const KINDS: PauseSuggestionKind[] = ['NO_SALES_AT_ZERO', 'SLOW_WITH_STOCKOUTS', 'EQUIVALENT_SELLING'];

/**
 * Products a store could pause (stock alerts O7, farmacia-ios
 * docs/stock-alerts-design.md §3), from last night's ProductStockStats and the
 * store's thresholds, computed on request. Never applied by itself.
 *
 * - EQUIVALENT_SELLING: at 0, and a product in its EquivalenceGroup that isn't
 *   paused, is in stock here and sold ≥ equivalentMinUnits since it ran out. Only
 *   manual groups: a shared medicationDefinitionId is never trusted on its own (§6.5).
 * - NO_SALES_AT_ZERO: at 0, last sale before the window and none since the stats ran.
 * - SLOW_WITH_STOCKOUTS: units ≤ slowMaxUnits and (days at 0 ≥ slowMinDaysAtZero or
 *   ≥ 2 stock-outs).
 *
 * One row per product: the first kind above whose rule it fits. Checked on the
 * rules, not on what's shown, so dismissing that kind hides the product rather
 * than bringing it back under a weaker one.
 *
 * Only what the store's catalog rows list (tracked, not discontinued, sold
 * here), not paused, with stats. A dismissal hides its kind until the window has
 * passed since it, or until new evidence: a sale (not for EQUIVALENT_SELLING,
 * which is about another product selling) or a receiving / received transfer
 * recorded after it. Equivalents first, then no sales, then slow; most days at 0
 * first, then by product id.
 */
export async function pauseSuggestions(prisma: PrismaClient, locationId: string, o: { page?: number; limit?: number; now?: Date } = {}) {
  const now = o.now ?? new Date();
  const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
  const page = Math.max(o.page ?? 1, 1);
  const settings = await prisma.stockAlertSettings.findUnique({ where: { locationId } });
  const windowDays = settings?.windowDays ?? 90;
  const windowStart = new Date(now.getTime() - windowDays * 86_400_000);

  const rows = await prisma.$queryRaw<Array<{
    id: string; name: string; kind: PauseSuggestionKind; last_sold_at: Date | null; units: number; days_at_zero: number; stock_outs: number;
    eq_id: string | null; eq_name: string | null; eq_units: number | null; total: bigint;
  }>>`
    WITH catalog AS (${catalogRowsSql(locationId, now)}),
    -- Only as far back as a check looks: the window, or an equivalent's run at 0 that began before it.
    sold AS (
      SELECT * FROM (${salesLines(locationId)}) l
       WHERE l.at >= LEAST(${windowStart}::timestamp, (
         SELECT MIN(st."zeroSince") FROM "ProductStockStats" st JOIN "Product" p ON p.id = st."productId"
          WHERE st."locationId" = ${locationId} AND p."equivalenceGroupId" IS NOT NULL))
    ),
    base AS (
      SELECT c.id, p.name, c.qty, c.zero_since, p."equivalenceGroupId" AS group_id,
             st."unitsSold" AS units, st."lastSoldAt" AS last_sold_at, st."daysAtZero" AS days_at_zero, st."stockOuts" AS stock_outs,
             c.qty <= 0
               AND (st."lastSoldAt" IS NULL OR st."lastSoldAt" < ${windowStart}::timestamp)
               AND NOT EXISTS (SELECT 1 FROM sold WHERE sold."productId" = c.id AND sold.quantity > 0 AND sold.at >= st."computedAt") AS no_sales
        FROM catalog c
        JOIN "Product" p ON p.id = c.id
        JOIN "ProductStockStats" st ON st."productId" = c.id AND st."locationId" = ${locationId}
       WHERE NOT c.paused
    ),
    equivalent AS (
      SELECT DISTINCT ON (b.id) b.id, e.id AS eq_id, e.name AS eq_name, u.units AS eq_units
        FROM base b
        JOIN "Product" e ON e."equivalenceGroupId" = b.group_id AND e.id <> b.id
        JOIN catalog ec ON ec.id = e.id AND NOT ec.paused AND ec.qty > 0
        CROSS JOIN LATERAL (SELECT COALESCE(SUM(quantity), 0)::int AS units FROM sold WHERE sold."productId" = e.id AND sold.at >= b.zero_since) u
       WHERE b.qty <= 0 AND b.zero_since IS NOT NULL AND u.units >= ${settings?.equivalentMinUnits ?? 3}
       ORDER BY b.id, u.units DESC, e.id
    ),
    suggested AS (
      -- One kind per product, by rule (not by what's shown): equivalent selling, then no sales, then slow.
      SELECT b.*, 'NO_SALES_AT_ZERO' AS kind, 1 AS rank, NULL AS eq_id, NULL AS eq_name, NULL::int AS eq_units FROM base b
       WHERE b.no_sales AND b.id NOT IN (SELECT id FROM equivalent)
      UNION ALL
      SELECT b.*, 'SLOW_WITH_STOCKOUTS', 2, NULL, NULL, NULL FROM base b
       WHERE NOT b.no_sales AND b.id NOT IN (SELECT id FROM equivalent) AND b.units <= ${settings?.slowMaxUnits ?? 2}
         AND (b.days_at_zero >= ${settings?.slowMinDaysAtZero ?? 30} OR b.stock_outs >= 2)
      UNION ALL
      SELECT b.*, 'EQUIVALENT_SELLING', 0, q.eq_id, q.eq_name, q.eq_units FROM base b JOIN equivalent q ON q.id = b.id
    )
    SELECT s.id, s.name, s.kind, s.last_sold_at, s.units, s.days_at_zero, s.stock_outs, s.eq_id, s.eq_name, s.eq_units, COUNT(*) OVER () AS total
      FROM suggested s
     WHERE NOT EXISTS (
       SELECT 1 FROM "PauseSuggestionDismissal" d
        WHERE d."productId" = s.id AND d."locationId" = ${locationId} AND d.kind::text = s.kind
          AND d."dismissedAt" > ${windowStart}::timestamp
          AND NOT (s.kind <> 'EQUIVALENT_SELLING'
                   AND EXISTS (SELECT 1 FROM sold WHERE sold."productId" = s.id AND sold.quantity > 0 AND sold.at > d."dismissedAt"))
          AND NOT EXISTS (
            SELECT 1 FROM "Inventory" i
             WHERE i."productId" = s.id AND i."locationId" = ${locationId} AND i."createdAt" > d."dismissedAt"
               AND (EXISTS (SELECT 1 FROM "InventoryReceiving" r WHERE r."inventoryBatchId" = i.id)
                    OR EXISTS (SELECT 1 FROM "TransferLine" t WHERE t."destinationInventoryId" = i.id))))
     ORDER BY s.rank, s.days_at_zero DESC, s.id
     LIMIT ${limit} OFFSET ${(page - 1) * limit}`;

  const data: PauseSuggestion[] = rows.map((r) => ({
    product: { id: r.id, name: r.name },
    kind: r.kind,
    lastSoldAt: r.last_sold_at?.toISOString() ?? null,
    unitsInWindow: r.kind === 'NO_SALES_AT_ZERO' ? 0 : r.units,
    daysAtZero: r.days_at_zero,
    stockOuts: r.stock_outs,
    equivalent: r.eq_id ? { id: r.eq_id, name: r.eq_name!, unitsSince: r.eq_units! } : null,
  }));
  // ponytail: a page past the end has no rows to carry the total; the phone only asks while hasMore.
  return { data, totalCount: Number(rows[0]?.total ?? 0), page, limit, windowDays };
}

/**
 * Hides suggestions at a store (see pauseSuggestions). Dismissing one again
 * restarts its window and records who did it last.
 */
export async function dismissPauseSuggestions(
  prisma: PrismaClient,
  o: { locationId: string; items: Array<{ productId: string; kind: PauseSuggestionKind }>; employeeId?: string; now?: Date },
): Promise<void> {
  const items = Array.isArray(o.items) ? o.items : [];
  if (items.length < 1 || items.length > 200) throw new BadRequestException('Envía de 1 a 200 sugerencias');
  if (items.some((i) => typeof i?.productId !== 'string' || !KINDS.includes(i.kind))) throw new BadRequestException('Sugerencia no válida');
  const productIds = [...new Set(items.map((i) => i.productId))];
  const found = await prisma.product.count({ where: { id: { in: productIds } } });
  if (found !== productIds.length) throw new BadRequestException('Producto no encontrado');

  const dismissedAt = o.now ?? new Date();
  const dismissedByEmployeeId = o.employeeId ?? null;
  await prisma.$transaction(
    items.map(({ productId, kind }) =>
      prisma.pauseSuggestionDismissal.upsert({
        where: { productId_locationId_kind: { productId, locationId: o.locationId, kind } },
        create: { productId, locationId: o.locationId, kind, dismissedAt, dismissedByEmployeeId },
        update: { dismissedAt, dismissedByEmployeeId },
      }),
    ),
  );
}

/**
 * Who may see and dismiss a store's pause suggestions (and its Alertas count):
 * an owner anywhere, a manager at the session's store only, as pausing.
 */
export function reviewsPauseSuggestionsAt(req: Pick<GuardedRequest, 'currentLocation'>, locationId: string): boolean {
  const here = req.currentLocation;
  return here?.role === 'OWNER' || (here?.role === 'MANAGER' && here.locationId === locationId);
}
