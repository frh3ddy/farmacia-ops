import { PrismaClient } from '@prisma/client';
import { businessDay, parseBusinessDate } from '../inventory/business-date';
import { salesLines } from '../sales-history/sales-history';

const DAY = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(day) + n * DAY).toISOString().slice(0, 10);

export interface StockStatsInput {
  /** Store days, inclusive. */
  window: { from: string; to: string };
  /** Stored stock days, sorted, from the last one before the day before `from` through `to`. */
  levels: Array<{ day: string; quantity: number }>;
  /** Sale lines by store day from the day before `from` through `to`; a return is negative. */
  sales: Array<{ day: string; quantity: number }>;
  lastSoldDay: string | null;
  /** The first day at 0 after the last day with stock; null if it never had stock. */
  zeroFrom: string | null;
}

export interface StockStats {
  unitsSold: number;
  weeksWithSales: number;
  typicalOnHand: number;
  daysAtZero: number;
  stockOuts: number;
  zeroSince: string | null;
  /** End-of-day stock on the window's last day; null while its stock is unknown. */
  stockAtEnd: number | null;
}

/**
 * One product's stats at one store over the window. Levels carry forward from
 * the last stored day. A day with a sale is never a day at 0: a sale proves the
 * units were on the shelf, whatever a history that never recorded them says.
 * Before its first stock day nothing is known about its stock (a sale proves
 * stock on its own day only), so those days aren't at 0. Weeks count back from the window's last day.
 */
export function stockStats({ window, levels, sales, lastSoldDay, zeroFrom }: StockStatsInput): StockStats {
  const soldOn = new Set(sales.filter((s) => s.quantity > 0).map((s) => s.day));
  const knownFrom = levels[0]?.day;
  // Unknown counts as at 0 for stock-outs only, so a first known 0 isn't one.
  const isZero = (day: string, level: number) => !knownFrom || day < knownFrom || (level === 0 && !soldOn.has(day));
  const known = (day: string) => !!knownFrom && day >= knownFrom;

  let i = 0;
  let level = 0;
  const levelOn = (day: string) => {
    while (i < levels.length && levels[i].day <= day) level = levels[i++].quantity;
    return level;
  };

  const before = addDays(window.from, -1);
  let wasZero = isZero(before, levelOn(before));
  let daysAtZero = 0;
  let stockOuts = 0;
  const inStock: number[] = [];
  let q = 0;
  for (let day = window.from; day <= window.to; day = addDays(day, 1)) {
    q = levelOn(day);
    const zero = isZero(day, q);
    if (zero && known(day)) daysAtZero++;
    if (zero && !wasZero) stockOuts++;
    if (q > 0) inStock.push(q);
    wasZero = zero;
  }
  inStock.sort((a, b) => a - b);

  const inWindow = sales.filter((s) => s.day >= window.from);
  const weeks = new Set(inWindow.filter((s) => s.quantity > 0).map((s) => Math.floor((Date.parse(window.to) - Date.parse(s.day)) / (7 * DAY))));
  const runStarts = [zeroFrom, lastSoldDay && addDays(lastSoldDay, 1)].filter((d): d is string => !!d).sort();
  return {
    unitsSold: inWindow.reduce((sum, s) => sum + s.quantity, 0),
    weeksWithSales: weeks.size,
    typicalOnHand: inStock[(inStock.length - 1) >> 1] ?? 0, // the lower median: an integer, like stock
    daysAtZero,
    stockOuts,
    // At 0 at the end of the window, even if it sold its last unit that day; never while its stock is unknown.
    zeroSince: knownFrom && q === 0 ? (runStarts.pop() ?? null) : null,
    stockAtEnd: knownFrom ? q : null,
  };
}

/**
 * Nightly, after the stock days: each active store's stats per product over
 * its window ending yesterday, for products with stored stock days, a sale in
 * the window, or stats from before. Upserted in one statement per store, so a
 * product whose stats didn't change isn't re-sent to the phones.
 */
export async function recordStockStats(prisma: PrismaClient, now = new Date()): Promise<number> {
  const to = businessDay(new Date(now.getTime() - DAY));
  const locations = await prisma.location.findMany({ where: { isActive: true }, select: { id: true, stockAlertSettings: { select: { windowDays: true } } } });
  let saved = 0;
  for (const { id: locationId, stockAlertSettings } of locations) {
    const windowDays = stockAlertSettings?.windowDays ?? 90;
    const from = addDays(to, 1 - windowDays);
    const before = addDays(from, -1);

    // Stored days from the last one before `before` on, per product.
    const levels = await prisma.$queryRaw<Array<{ productId: string; day: Date; quantity: number }>>`
      SELECT "productId", day, quantity FROM "StockDay" d
       WHERE "locationId" = ${locationId} AND day <= ${to}::date
         AND day >= coalesce((SELECT max(day) FROM "StockDay" p WHERE p."productId" = d."productId" AND p."locationId" = d."locationId" AND p.day <= ${before}::date), ${before}::date)
       ORDER BY "productId", day`;
    const lines = await prisma.$queryRaw<Array<{ productId: string; quantity: number; at: Date }>>`
      SELECT * FROM (${salesLines(locationId)}) l WHERE at >= ${parseBusinessDate(before, 'start')} AND at < ${parseBusinessDate(addDays(to, 1), 'start')}`;
    const lastSold = await prisma.$queryRaw<Array<{ productId: string; at: Date }>>`
      SELECT "productId", max(at) AS at FROM (${salesLines(locationId)}) l WHERE quantity > 0 GROUP BY 1`;
    // Products stored before: recomputed too, so one whose sales left the window doesn't keep them.
    const stored = await prisma.productStockStats.findMany({ where: { locationId }, select: { productId: true } });
    // The first stored day after the last one with stock: where the current run at 0 began.
    const zeroFrom = await prisma.$queryRaw<Array<{ productId: string; day: Date }>>`
      SELECT d."productId", min(d.day) AS day FROM "StockDay" d
        JOIN (SELECT "productId", max(day) AS last FROM "StockDay" WHERE "locationId" = ${locationId} AND quantity > 0 AND day <= ${to}::date GROUP BY 1) p
          ON p."productId" = d."productId" AND d.day > p.last
       WHERE d."locationId" = ${locationId} AND d.day <= ${to}::date GROUP BY 1`;

    const dayOf = (d: Date) => d.toISOString().slice(0, 10); // a stored @db.Date
    const levelsOf = group(levels, (r) => ({ day: dayOf(r.day), quantity: r.quantity }));
    const salesOf = group(lines, (r) => ({ day: businessDay(r.at), quantity: r.quantity }));
    const lastSoldOf = new Map(lastSold.map((r) => [r.productId, r.at]));
    const zeroFromOf = new Map(zeroFrom.map((r) => [r.productId, dayOf(r.day)]));

    const rows = [...new Set([...levelsOf.keys(), ...salesOf.keys(), ...stored.map((r) => r.productId)])].map((productId) => {
      const lastSoldAt = lastSoldOf.get(productId) ?? null;
      const s = stockStats({
        window: { from, to },
        levels: levelsOf.get(productId) ?? [],
        sales: salesOf.get(productId) ?? [],
        lastSoldDay: lastSoldAt && businessDay(lastSoldAt),
        zeroFrom: zeroFromOf.get(productId) ?? null,
      });
      return { productId, locationId, windowDays, ...s, lastSoldAt, zeroSince: s.zeroSince && parseBusinessDate(s.zeroSince, 'start') };
    });
    if (rows.length) {
      await prisma.$executeRaw`
        INSERT INTO "ProductStockStats" ("productId", "locationId", "windowDays", "unitsSold", "weeksWithSales", "lastSoldAt", "typicalOnHand", "daysAtZero", "stockOuts", "zeroSince", "stockAtEnd", "computedAt")
        SELECT "productId", "locationId", "windowDays", "unitsSold", "weeksWithSales", "lastSoldAt", "typicalOnHand", "daysAtZero", "stockOuts", "zeroSince", "stockAtEnd", ${now}
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x("productId" text, "locationId" text, "windowDays" int, "unitsSold" int, "weeksWithSales" int,
               "lastSoldAt" timestamp, "typicalOnHand" int, "daysAtZero" int, "stockOuts" int, "zeroSince" timestamp, "stockAtEnd" int)
        ON CONFLICT ("productId", "locationId") DO UPDATE SET
          "windowDays" = EXCLUDED."windowDays", "unitsSold" = EXCLUDED."unitsSold", "weeksWithSales" = EXCLUDED."weeksWithSales",
          "lastSoldAt" = EXCLUDED."lastSoldAt", "typicalOnHand" = EXCLUDED."typicalOnHand", "daysAtZero" = EXCLUDED."daysAtZero",
          "stockOuts" = EXCLUDED."stockOuts", "zeroSince" = EXCLUDED."zeroSince", "stockAtEnd" = EXCLUDED."stockAtEnd", "computedAt" = EXCLUDED."computedAt"`;
    }
    saved += rows.length;
  }
  return saved;
}

function group<R extends { productId: string }, T>(rows: R[], map: (r: R) => T): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.productId);
    if (list) list.push(map(r));
    else out.set(r.productId, [map(r)]);
  }
  return out;
}
