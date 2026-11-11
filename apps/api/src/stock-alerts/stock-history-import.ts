import { PrismaClient } from '@prisma/client';
import type { SquareClient } from 'square';
import { businessDay } from '../inventory/business-date';
import { preferredMapping } from '../inventory/square-sync';
import { HISTORY_START } from '../sales-history/sales-history';
import { isUnreadable, mergeDays, replayStock, stockEvents, type StockEvent, type StockDayRow } from './stock-history';
import { appStockDays, changedRows } from './stock-days';

const WORST = 20;

export interface StockHistoryReport {
  stores: Array<{
    store: string;
    cutoverDay: string | null;
    /** Square items with inventory changes at the store, linked to a product. */
    items: number;
    /** Of them, how many replay to exactly Square's current count (below 0 taken as 0, as the replay does). */
    matching: number;
    matchingShare: number;
    worst: Array<{ variationId: string; product: string; replay: number; square: number; difference: number }>;
    /** Square items with changes but no product (deleted or never mapped): not in the history. */
    unmapped: number;
  }>;
  /** Square changes the replay couldn't place (stock-history.ts isUnreadable), by change type. Many means the history is incomplete. */
  unreadable: { total: number; byType: Record<string, number> };
  /** Products sold under more than one Square item at a store; their days are added up. */
  multiItemProducts: number;
  rows: number;
  saved: number;
}

/**
 * Rebuilds StockDay once: Square's inventory changes replayed (stock-history.ts)
 * for days before each store's cutover, the app's own movements from it. The
 * report compares each item's full replay with Square's current count, so the
 * owner can judge the history before it is saved. Only reads Square. Saving
 * replaces the stores' stored days.
 */
export async function importStockHistory(
  prisma: PrismaClient,
  client: { inventory: Pick<SquareClient['inventory'], 'batchGetChanges' | 'batchGetCounts'> },
  { save, now = new Date() }: { save: boolean; now?: Date },
): Promise<StockHistoryReport> {
  const locations = await prisma.location.findMany({ where: { squareId: { not: null } }, select: { id: true, squareId: true, name: true } });
  const locationIds = locations.map((l) => l.squareId!);
  const mappings = await prisma.catalogMapping.findMany({
    where: { employeeId: null },
    select: { squareVariationId: true, productId: true, locationId: true, product: { select: { name: true } } },
  });
  const mappingsOf = new Map<string, typeof mappings>();
  for (const m of mappings) {
    const list = mappingsOf.get(m.squareVariationId);
    if (list) list.push(m);
    else mappingsOf.set(m.squareVariationId, [m]);
  }

  const events = new Map<string, StockEvent[]>(); // `${variation}|${squareLocation}`
  const unreadable: StockHistoryReport['unreadable'] = { total: 0, byType: {} };
  // No `types`: Square then sends its default (counts and adjustments); any other type it sends is counted as unreadable.
  for await (const change of await client.inventory.batchGetChanges({ locationIds, updatedAfter: HISTORY_START, limit: 1000 })) {
    if (isUnreadable(change)) {
      const type = change.type ?? 'UNKNOWN';
      unreadable.total++;
      unreadable.byType[type] = (unreadable.byType[type] ?? 0) + 1;
      continue;
    }
    for (const e of stockEvents(change)) {
      const key = `${e.variationId}|${e.locationSquareId}`;
      const list = events.get(key);
      if (list) list.push(e);
      else events.set(key, [e]);
    }
  }
  const squareCount = new Map<string, number>();
  for await (const c of await client.inventory.batchGetCounts({ locationIds, states: ['IN_STOCK'], limit: 1000 })) {
    if (c.catalogObjectId && c.locationId) squareCount.set(`${c.catalogObjectId}|${c.locationId}`, Math.round(Number(c.quantity ?? 0)));
  }

  const report: StockHistoryReport = { stores: [], unreadable, multiItemProducts: 0, rows: 0, saved: 0 };
  const data: Array<{ productId: string; locationId: string; day: Date; quantity: number; restocked: boolean }> = [];
  for (const location of locations) {
    const lock = await prisma.cutoverLock.findFirst({
      where: { OR: [{ locationId: location.id }, { locationId: null }], isLocked: true },
      orderBy: { cutoverDate: 'desc' },
    });
    const cutoverDay = lock ? businessDay(lock.cutoverDate) : null;
    const squareDays = new Map<string, StockDayRow[][]>(); // product → one series per Square item
    const store: StockHistoryReport['stores'][number] = { store: location.name, cutoverDay, items: 0, matching: 0, matchingShare: 0, worst: [], unmapped: 0 };
    const mismatches: StockHistoryReport['stores'][number]['worst'] = [];

    for (const [key, itemEvents] of events) {
      const [variationId, squareLocation] = key.split('|');
      if (squareLocation !== location.squareId) continue;
      const { days, final } = replayStock(itemEvents);
      const mapping = preferredMapping(mappingsOf.get(variationId) ?? [], location.id);
      if (!mapping) {
        store.unmapped++;
        continue;
      }
      const counted = Math.max(0, squareCount.get(key) ?? 0);
      store.items++;
      if (final === counted) store.matching++;
      else mismatches.push({ variationId, product: mapping.product.name, replay: final, square: counted, difference: final - counted });
      const before = days.filter((d) => !cutoverDay || d.day < cutoverDay);
      squareDays.set(mapping.productId, [...(squareDays.get(mapping.productId) ?? []), before]);
    }
    store.matchingShare = store.items ? Math.round((store.matching / store.items) * 1000) / 1000 : 0;
    store.worst = mismatches.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference)).slice(0, WORST);
    report.stores.push(store);
    report.multiItemProducts += [...squareDays.values()].filter((s) => s.length > 1).length;

    const appDays = cutoverDay ? await appStockDays(prisma, location.id, cutoverDay) : new Map<string, StockDayRow[]>();
    for (const productId of new Set([...squareDays.keys(), ...appDays.keys()])) {
      const before = mergeDays(squareDays.get(productId) ?? [[]]);
      const after = cutoverDay ? appDays.get(productId) ?? [{ day: cutoverDay, quantity: 0, restocked: false }] : [];
      for (const r of [...changedRows(undefined, before), ...changedRows(before[before.length - 1], after)]) {
        data.push({ productId, locationId: location.id, day: new Date(r.day), quantity: r.quantity, restocked: r.restocked });
      }
    }
  }
  report.rows = data.length;
  if (save) {
    // One insert is fine at production size: Prisma splits it under Postgres's bind-parameter limit.
    await prisma.$transaction([
      prisma.stockDay.deleteMany({ where: { locationId: { in: locations.map((l) => l.id) }, day: { lte: new Date(businessDay(now)) } } }),
      prisma.stockDay.createMany({ data }),
    ]);
    report.saved = data.length;
  }
  return report;
}
