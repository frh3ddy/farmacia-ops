import { Prisma, PrismaClient } from '@prisma/client';
import type { Square, SquareClient } from 'square';
import { BUSINESS_TIME_ZONE } from '../inventory/business-date';
import { preferredMapping } from '../inventory/square-sync';

const DAY = 86_400_000;
/** Before the stores' first Square order (2020-07-17). */
const HISTORY_START = '2020-01-01T00:00:00.000Z';

export interface SalesHistoryImport {
  pages: number;
  orders: number;
  lines: number;
  saved: number;
  unmapped: number;
}

/**
 * Imports the stores' closed Square orders into SalesHistoryLine, one row per
 * line item and a negative row per returned line. Only reads Square. A rerun
 * starts from the last order saved, and an order line is saved once, so a run
 * that stops is resumed by running it again.
 */
export async function importSalesHistory(
  prisma: PrismaClient,
  client: Pick<SquareClient, 'orders'>,
  { save }: { save: boolean },
): Promise<SalesHistoryImport> {
  const locations = await prisma.location.findMany({ where: { squareId: { not: null } }, select: { id: true, squareId: true } });
  const locationOf = new Map(locations.map((l) => [l.squareId!, l.id]));
  const mappings = await prisma.catalogMapping.findMany({ select: { squareVariationId: true, productId: true, locationId: true } });
  const mappingsOf = new Map<string, typeof mappings>();
  for (const m of mappings) mappingsOf.set(m.squareVariationId, [...(mappingsOf.get(m.squareVariationId) ?? []), m]);
  const latest = await prisma.salesHistoryLine.aggregate({ _max: { soldAt: true } });

  const result: SalesHistoryImport = { pages: 0, orders: 0, lines: 0, saved: 0, unmapped: 0 };
  let cursor: string | undefined;
  do {
    const page = await client.orders.search({
      locationIds: [...locationOf.keys()],
      cursor,
      limit: 500,
      query: {
        filter: {
          stateFilter: { states: ['COMPLETED'] },
          dateTimeFilter: { closedAt: { startAt: latest._max.soldAt?.toISOString() ?? HISTORY_START } },
        },
        sort: { sortField: 'CLOSED_AT', sortOrder: 'ASC' },
      },
    });
    if (page.errors?.length) throw new Error(page.errors.map((e) => e.detail ?? e.code).join('; '));

    const rows = (page.orders ?? []).flatMap((order) => {
      const locationId = locationOf.get(order.locationId);
      if (!locationId || !order.id || !order.closedAt) return [];
      result.orders++;
      // What a live Sale for this order is keyed on: its payment, or for an
      // exchange (a return order, no tender) the refund (sale.worker.ts processRefundJob).
      // ponytail: tenders[0] only — the stores take one cash payment; store every tender if split tender comes.
      const liveSaleKey = order.tenders?.[0]?.paymentId ?? order.tenders?.[0]?.id ?? order.refunds?.[0]?.id ?? null;
      const row = (uid: string, catalogObjectId: string | null | undefined, quantity: number) => ({
        squareOrderId: order.id!,
        squareLineUid: uid,
        squarePaymentId: liveSaleKey,
        locationId,
        productId: catalogObjectId ? preferredMapping(mappingsOf.get(catalogObjectId) ?? [], locationId)?.productId ?? null : null,
        squareVariationId: catalogObjectId ?? null,
        quantity,
        soldAt: new Date(order.closedAt!),
      });
      // ponytail: a weighed quantity ("1.5") is rounded; the stores sell whole units.
      const units = (q: string) => Math.round(Number(q));
      return [
        ...(order.lineItems ?? []).map((l, i) => row(l.uid ?? `line-${i}`, l.catalogObjectId, units(l.quantity))),
        ...(order.returns ?? []).flatMap((r: Square.OrderReturn) =>
          (r.returnLineItems ?? []).map((l, i) => row(l.uid ?? `return-${i}`, l.catalogObjectId, -units(l.quantity))),
        ),
      ].filter((r) => r.quantity !== 0);
    });

    result.pages++;
    result.lines += rows.length;
    result.unmapped += rows.filter((r) => !r.productId).length;
    if (save && rows.length) result.saved += (await prisma.salesHistoryLine.createMany({ data: rows, skipDuplicates: true })).count;
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return result;
}

/**
 * Every order line at a store: imported history, less what the app also
 * recorded live (an order whose payment is a Sale, a return line it took back),
 * plus live sales net of their returns.
 */
const storeLines = (locationId: string, productId?: string) => Prisma.sql`
  SELECT h."squareOrderId" AS "order", h.quantity, h."soldAt" AS at
    FROM "SalesHistoryLine" h
   WHERE h."locationId" = ${locationId}
     ${productId ? Prisma.sql`AND h."productId" = ${productId}` : Prisma.empty}
     AND NOT EXISTS (SELECT 1 FROM "Sale" s WHERE s."squareId" = h."squarePaymentId")
     -- a returned line the worker took back live (sale.worker.ts recordSquareReturns)
     AND NOT EXISTS (SELECT 1 FROM "SaleReturn" r WHERE r."clientRequestId" = 'square-return-line:' || h."squareLineUid")
  UNION ALL
  SELECT s.id, i.quantity, s."createdAt"
    FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
   WHERE s."locationId" = ${locationId} ${productId ? Prisma.sql`AND i."productId" = ${productId}` : Prisma.empty}
  UNION ALL
  SELECT s.id, -ri.quantity, r."returnedAt"
    FROM "SaleReturnItem" ri
    JOIN "SaleReturn" r ON r.id = ri."returnId"
    JOIN "SaleItem" i ON i.id = ri."saleItemId"
    JOIN "Sale" s ON s.id = i."saleId"
   WHERE s."locationId" = ${locationId} ${productId ? Prisma.sql`AND i."productId" = ${productId}` : Prisma.empty}`;

export interface SalesVelocity {
  lastSoldAt: string | null;
  unitsLast30d: number;
  unitsLast90d: number;
  daysSinceLastSale: number | null;
}

/** How fast a product sells at a store: units net of returns, and its last sale. */
export async function salesVelocity(prisma: PrismaClient, productId: string, locationId: string, now = new Date()): Promise<SalesVelocity> {
  const [row] = await prisma.$queryRaw<Array<{ last: Date | null; u30: number; u90: number }>>`
    SELECT max(at) FILTER (WHERE quantity > 0) AS last,
           coalesce(sum(quantity) FILTER (WHERE at >= ${new Date(now.getTime() - 30 * DAY)}), 0)::int AS u30,
           coalesce(sum(quantity) FILTER (WHERE at >= ${new Date(now.getTime() - 90 * DAY)}), 0)::int AS u90
      FROM (${storeLines(locationId, productId)}) lines`;
  return {
    lastSoldAt: row.last?.toISOString() ?? null,
    unitsLast30d: row.u30,
    unitsLast90d: row.u90,
    daysSinceLastSale: row.last ? Math.floor((now.getTime() - row.last.getTime()) / DAY) : null,
  };
}

export interface BusyHours {
  timezone: string;
  cells: Array<{ dayOfWeek: number; hour: number; orders: number }>;
}

/** Orders a store closed in the last `days`, by day of week (0 = Sunday) and hour on the store's clock. */
export async function busyHours(prisma: PrismaClient, locationId: string, days: number, now = new Date()): Promise<BusyHours> {
  const local = Prisma.sql`(at AT TIME ZONE 'UTC' AT TIME ZONE ${BUSINESS_TIME_ZONE})`;
  const cells = await prisma.$queryRaw<BusyHours['cells']>`
    SELECT extract(dow FROM ${local})::int AS "dayOfWeek", extract(hour FROM ${local})::int AS hour, count(DISTINCT "order")::int AS orders
      FROM (${storeLines(locationId)}) lines
     WHERE quantity > 0 AND at >= ${new Date(now.getTime() - days * DAY)}
     GROUP BY 1, 2
     ORDER BY 1, 2`;
  return { timezone: BUSINESS_TIME_ZONE, cells };
}
