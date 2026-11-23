import type { PrismaClient } from '@prisma/client';
import { catalogRowsSql } from '../products/products.service';
import { stockAlertSettingsOf } from '../stock-alerts/stock-alert-settings';
import { needOf, stockPositions, transferSuggestions } from './transfer-suggestions';

type Level = 'low' | 'out';
interface Alert { level: Level; priority: number }

/** A row at a store that orders from suppliers: for itself and for the stores that buy through it. */
export interface PurchaseNeed {
  product: { id: string; name: string };
  /** The most urgent across this store and the ones it buys for. */
  level: Level;
  priority: number;
  /** 0 unless the product alerts here. */
  needHere: number;
  /** Stores that buy through this one, where the product alerts. */
  forOthers: Array<{ locationId: string; need: number; fromSpare: number; toOrder: number }>;
  toOrderTotal: number;
}

/** A row at a store that buys through another: what that store sends now and what it orders for it. */
export interface PurchaseNeedThroughReceiving {
  product: { id: string; name: string };
  level: Level;
  priority: number;
  need: number;
  receivingSends: number;
  receivingOrders: number;
}

/**
 * Por pedir: each product alerting (O4, sellable stock) at a store, with what
 * it's short of (O12's need: max(⌈cover × rate⌉, typical) − sellable − in transit).
 *
 * - A store others buy through (or that buys for itself) also lists what
 *   alerts at those stores: it sends what it can spare (the same numbers as
 *   GET /transfers/suggestions, expiry checks included) and orders the rest.
 * - A store that buys through another orders nothing: each row says what the
 *   receiving store sends and what it orders for it.
 *
 * Most urgent first: out of stock, then lost sales a day (priority), then name.
 */
export async function purchaseNeeds(prisma: PrismaClient, locationId: string, o: { now?: Date } = {}) {
  const now = o.now ?? new Date();
  const { receivingLocationId, suppliesLocationIds } = await stockAlertSettingsOf(prisma, locationId);
  const stores = receivingLocationId ? [locationId] : [locationId, ...suppliesLocationIds];

  const alerts = new Map<string, Map<string, Alert>>(); // store → product → alert
  for (const store of stores) {
    const rows = await prisma.$queryRaw<Array<{ id: string; level: Level; priority: number }>>`
      SELECT id, level, priority FROM (${catalogRowsSql(store, now)}) c WHERE level <> 'none'`;
    alerts.set(store, new Map(rows.map((r) => [r.id, { level: r.level, priority: r.priority }])));
  }
  const ids = [...new Set([...alerts.values()].flatMap((m) => [...m.keys()]))];
  if (!ids.length) return { receivingLocationId, suppliesLocationIds, rows: [] };

  const sender = receivingLocationId ?? locationId;
  const [positions, sent] = await Promise.all([
    stockPositions(prisma, { origin: locationId, stores, productIds: ids, now }),
    transferSuggestions(prisma, { fromLocationId: sender, productIds: ids, now }),
  ]);
  const sends = (productId: string, to: string) => sent.suggestions.find((s) => s.product.id === productId && s.toLocationId === to)?.suggested ?? 0;
  const needAt = (productId: string, store: string) => Math.max(0, needOf(positions.get(productId)!.find((p) => p.location_id === store)!));
  const productOf = (id: string) => ({ id, name: positions.get(id)![0].name });

  const urgency = (id: string): Alert => {
    const found = stores.map((s) => alerts.get(s)!.get(id)).filter((a): a is Alert => !!a);
    return { level: found.some((a) => a.level === 'out') ? 'out' : 'low', priority: Math.max(...found.map((a) => a.priority)) };
  };
  const byUrgency = <R extends Alert & { product: { id: string; name: string } }>(rows: R[]) =>
    rows.sort((a, b) => Number(b.level === 'out') - Number(a.level === 'out') || b.priority - a.priority || a.product.name.localeCompare(b.product.name) || a.product.id.localeCompare(b.product.id));

  if (receivingLocationId) {
    const rows: PurchaseNeedThroughReceiving[] = ids.map((id) => {
      const need = needAt(id, locationId);
      const receivingSends = Math.min(sends(id, locationId), need);
      return { product: productOf(id), ...urgency(id), need, receivingSends, receivingOrders: need - receivingSends };
    });
    return { receivingLocationId, suppliesLocationIds, rows: byUrgency(rows) };
  }

  const rows: PurchaseNeed[] = ids.map((id) => {
    // Only what alerts here: a paused product or one that isn't a regular seller here isn't ordered for here.
    const needHere = alerts.get(locationId)!.has(id) ? needAt(id, locationId) : 0;
    const forOthers = suppliesLocationIds
      .filter((s) => alerts.get(s)!.has(id))
      .map((s) => {
        const need = needAt(id, s);
        const fromSpare = Math.min(sends(id, s), need);
        return { locationId: s, need, fromSpare, toOrder: need - fromSpare };
      });
    return { product: productOf(id), ...urgency(id), needHere, forOthers, toOrderTotal: needHere + forOthers.reduce((n, f) => n + f.toOrder, 0) };
  });
  return { receivingLocationId, suppliesLocationIds, rows: byUrgency(rows) };
}
