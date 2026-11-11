import type { Square } from 'square';
import { businessDay } from '../inventory/business-date';

/** One change to a Square item's IN_STOCK level at one store. */
export interface StockEvent {
  variationId: string;
  locationSquareId: string;
  at: string;
  /** count: stock becomes `quantity`; delta: stock moves by `quantity`. */
  kind: 'count' | 'delta';
  quantity: number;
  /** Supply came in (receiving, transfer in). A return to the shelf adds units but isn't one. */
  restock: boolean;
}

export interface StockDayRow {
  day: string; // YYYY-MM-DD on the store clock
  quantity: number; // end of day
  restocked: boolean;
}

/** Where stock comes back from a customer or a correction, not from supply. */
const NOT_SUPPLY = new Set<string>(['SOLD', 'SOLD_ONLINE', 'RETURNED_BY_CUSTOMER', 'UNLINKED_RETURN', 'WASTE']);

// ponytail: a weighed quantity ("1.5") is rounded; the stores sell whole units.
const units = (q: string | null | undefined) => Math.round(Number(q ?? 0));

/**
 * A change the replay can't place: an adjustment with no store ids (older
 * records might come back with only the retired location_id), a count without
 * a store, or a change type it doesn't read. Counted in the report, so a
 * history missing them doesn't pass for complete.
 */
export function isUnreadable(change: Square.InventoryChange): boolean {
  if (change.type === 'PHYSICAL_COUNT') {
    const c = change.physicalCount;
    return !c?.catalogObjectId || !c.locationId || !c.occurredAt;
  }
  if (change.type === 'ADJUSTMENT') {
    const a = change.adjustment;
    return !a?.catalogObjectId || !a.occurredAt || (!a.fromLocationId && !a.toLocationId);
  }
  return true;
}

/** What a Square inventory change does to IN_STOCK at each store it touches. */
export function stockEvents(change: Square.InventoryChange): StockEvent[] {
  const c = change.physicalCount;
  if (change.type === 'PHYSICAL_COUNT' && c) {
    if (c.state !== 'IN_STOCK' || !c.catalogObjectId || !c.locationId || !c.occurredAt) return [];
    return [{ variationId: c.catalogObjectId, locationSquareId: c.locationId, at: c.occurredAt, kind: 'count', quantity: units(c.quantity), restock: false }];
  }
  const a = change.adjustment;
  if (change.type !== 'ADJUSTMENT' || !a?.catalogObjectId || !a.occurredAt) return [];
  const base = { variationId: a.catalogObjectId, at: a.occurredAt, kind: 'delta' as const };
  const q = units(a.quantity);
  const out: StockEvent[] = [];
  if (a.fromState === 'IN_STOCK' && a.fromLocationId) out.push({ ...base, locationSquareId: a.fromLocationId, quantity: -q, restock: false });
  if (a.toState === 'IN_STOCK' && a.toLocationId) {
    const isReturn = !!a.refundId || NOT_SUPPLY.has(a.fromState ?? '');
    out.push({ ...base, locationSquareId: a.toLocationId, quantity: q, restock: !isReturn });
  }
  // IN_STOCK → IN_STOCK at the same store moves nothing.
  return out.length === 2 && a.fromLocationId === a.toLocationId ? [] : out;
}

/**
 * End-of-day stock of one Square item at one store, from its events: a count
 * sets the level (above the replay it's a restock, below it a correction),
 * deltas move it, and it never goes below 0 (nor does a negative count) (a sale proves the units were
 * there, from a restock Square never recorded). One row per day with a change.
 */
export function replayStock(events: StockEvent[]): { days: StockDayRow[]; final: number } {
  const days: StockDayRow[] = [];
  let stock = 0;
  for (const e of [...events].sort((x, y) => Date.parse(x.at) - Date.parse(y.at))) {
    const next = Math.max(0, e.kind === 'count' ? e.quantity : stock + e.quantity);
    const restock = e.kind === 'count' ? next > stock : e.restock;
    stock = next;
    const day = businessDay(new Date(e.at));
    const last = days[days.length - 1];
    if (last?.day === day) {
      last.quantity = stock;
      last.restocked ||= restock;
    } else days.push({ day, quantity: stock, restocked: restock });
  }
  return { days, final: stock };
}

/** Several items' day rows (one product sold under more than one Square item) as one: levels in force each day, added up. */
export function mergeDays(series: StockDayRow[][]): StockDayRow[] {
  if (series.length === 1) return series[0];
  const level = series.map(() => 0);
  const byDay = new Map<string, Array<[number, StockDayRow]>>();
  series.forEach((rows, i) => rows.forEach((r) => byDay.set(r.day, [...(byDay.get(r.day) ?? []), [i, r]])));
  return [...byDay.keys()].sort().map((day) => {
    const rows = byDay.get(day)!;
    for (const [i, r] of rows) level[i] = r.quantity;
    return { day, quantity: level.reduce((s, q) => s + q, 0), restocked: rows.some(([, r]) => r.restocked) };
  });
}
