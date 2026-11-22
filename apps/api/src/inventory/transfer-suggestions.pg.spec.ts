/**
 * Transfer suggestions: what a store can send to the others, from live stock,
 * lots, units in transit and the nightly stats (see testing/pglite.ts).
 * Default settings: 90-day window, 14 days of cover; 90 units sold = 1 a day.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { businessDay } from './business-date';
import { transferSuggestions } from './transfer-suggestions';

let prisma: PrismaService;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
}, 120_000);

afterAll(() => stop?.());

const NOW = new Date('2026-11-21T18:00:00Z');
const TODAY = businessDay(NOW);
/** An expiry day `offset` days from today (stored at UTC midnight, as older rows). */
const expiry = (offset: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000);

interface At { lots?: Array<[number, Date | null]>; sold?: number; typical?: number; paused?: boolean; noStats?: boolean; inTransit?: number }

/** An origin and destination stores of their own, all active, and a way to add a product at each. */
async function stores(destinations = 1) {
  await prisma.location.updateMany({ data: { isActive: false } }); // earlier tests' stores aren't destinations
  const location = async (name: string) => (await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name } })).id;
  const origin = await location('Origen');
  const dests: string[] = [];
  for (let i = 0; i < destinations; i++) dests.push(await location(`Destino${i}`));
  let received = 0;
  const product = async (name: string, at: Record<string, At>, o: { tracksInventory?: boolean; soldOnlyAtLocationId?: string; isDiscontinued?: boolean } = {}) => {
    const { id } = await prisma.product.create({ data: { name, ...o } });
    for (const [locationId, a] of Object.entries(at)) {
      for (const [quantity, expiryDate] of a.lots ?? []) {
        // Lots are received in the order given: the first is the first out.
        await prisma.inventory.create({ data: { productId: id, locationId, quantity, unitCost: 1, receivedAt: new Date(Date.UTC(2026, 0, 1 + received++)), expiryDate } });
      }
      if (!a.noStats) {
        await prisma.productStockStats.create({
          data: { productId: id, locationId, windowDays: 90, unitsSold: a.sold ?? 0, weeksWithSales: 10, typicalOnHand: a.typical ?? 0, daysAtZero: 0, stockOuts: 0, computedAt: NOW },
        });
      }
      if (a.paused) await prisma.productStoreStatus.create({ data: { productId: id, locationId, pausedAt: NOW, pauseReason: 'OTHER' } });
      if (a.inTransit) await prisma.transfer.create({ data: { productId: id, fromLocationId: origin, toLocationId: locationId, quantity: a.inTransit, status: 'IN_TRANSIT', shippedAt: NOW } });
    }
    return id;
  };
  const suggest = (o: { toLocationId?: string; productIds?: string[] } = {}) => transferSuggestions(prisma, { fromLocationId: origin, now: NOW, ...o });
  return { origin, dests, product, suggest };
}

describe('transferSuggestions', () => {
  test('what one store needs and the other can spare', async () => {
    const { origin, dests: [dest], product, suggest } = await stores();
    // Origin: 40 sellable, 1 a day, keeps 14, can spare 26. Destination: 1 a day,
    // typical 20, has 3 and 2 on the way: needs max(14, 20) − 3 − 2 = 15.
    const id = await product('Paracetamol', { [origin]: { lots: [[40, null]], sold: 90 }, [dest]: { lots: [[3, null]], sold: 90, typical: 20, inTransit: 2 } });

    assert({
      given: 'a destination short of its cover and typical stock, with units on the way, and an origin with more than its own cover',
      should: 'suggest the smaller of what it needs and what the origin can spare',
      actual: await suggest(),
      expected: {
        suggestions: [{
          product: { id, name: 'Paracetamol' }, toLocationId: dest, suggested: 15, destSellable: 3, destExpired: 0, destRatePerWeek: 7,
          originSellable: 40, originAfter: 25,
        }],
        skipped: [],
      },
    });
  });

  test('more need than spare', async () => {
    const { origin, dests: [slower, faster], product, suggest } = await stores(2);
    // Origin spares 10. The faster store needs 14, the slower one 7.
    await product('Ibuprofeno', { [origin]: { lots: [[24, null]], sold: 90 }, [slower]: { sold: 45, typical: 5 }, [faster]: { sold: 90, typical: 3 } });
    const { suggestions } = await suggest();

    assert({
      given: 'two stores that need more than the origin can spare',
      should: 'give the spare to the store losing the most sales first',
      actual: suggestions.map((s) => [s.toLocationId, s.suggested, s.originAfter]),
      expected: [[faster, 10, 14]],
    });
  });

  test('the origin keeps its typical stock', async () => {
    const { origin, dests: [dest], product, suggest } = await stores();
    // Origin: 0.1 a day (cover 2) but typically holds 10. Destination needs 14.
    await product('AtTypical', { [origin]: { lots: [[10, null]], sold: 9, typical: 10 }, [dest]: { sold: 90, typical: 5 } });
    await product('AboveTypical', { [origin]: { lots: [[15, null]], sold: 9, typical: 10 }, [dest]: { sold: 90, typical: 5 } });
    const { suggestions } = await suggest();

    assert({
      given: 'a slow origin at its typical stock, and one 5 above it',
      should: 'spare nothing from the first and only the 5 above typical from the second',
      actual: suggestions.map((s) => [s.product.name, s.suggested, s.originAfter]),
      expected: [['AboveTypical', 5, 10]],
    });

    // After the move: the origin at its typical 10, the destination well stocked (40, keeps 14).
    const afterMove = await product('AfterMove', { [origin]: { lots: [[10, null]], sold: 9, typical: 10 }, [dest]: { lots: [[40, null]], sold: 90, typical: 5 } });
    const { suggestions: back } = await transferSuggestions(prisma, { fromLocationId: dest, productIds: [afterMove], now: NOW });
    assert({
      given: 'the destination with stock to spare, and the origin left at its typical stock',
      should: 'not suggest sending it back',
      actual: back.filter((s) => s.toLocationId === origin).length,
      expected: 0,
    });
  });

  test('nothing to send', async () => {
    const { origin, dests: [dest], product, suggest } = await stores();
    await product('Justo', { [origin]: { lots: [[14, null]], sold: 90 }, [dest]: { sold: 90, typical: 5 } });
    await product('Lleno', { [origin]: { lots: [[50, null]], sold: 90 }, [dest]: { lots: [[20, null]], sold: 90, typical: 5 } });
    await product('NoSeVendeAlla', { [origin]: { lots: [[50, null]] }, [dest]: { typical: 5 } });

    assert({
      given: 'an origin with no spare, a destination already covered, and one that never sells it',
      should: 'suggest nothing',
      actual: await suggest(),
      expected: { suggestions: [], skipped: [] },
    });
  });

  test('skipped', async () => {
    const { origin, dests: [dest], product, suggest } = await stores();
    const enough = { lots: [[50, null]] as Array<[number, Date | null]>, sold: 90 };
    const paused = await product('Pausado', { [origin]: enough, [dest]: { sold: 90, typical: 5, paused: true } });
    const noStats = await product('SinEstadisticas', { [origin]: enough, [dest]: { noStats: true } });
    const oneStore = await product('SoloOrigen', { [origin]: enough }, { soldOnlyAtLocationId: origin });
    const service = await product('Servicio', {}, { tracksInventory: false });
    const discontinued = await product('Descontinuado', { [origin]: enough, [dest]: { sold: 90, typical: 5 } }, { isDiscontinued: true });
    const { skipped } = await suggest({ productIds: [paused, noStats, oneStore, service, discontinued] });

    assert({
      given: 'products paused at the destination, without stats there, sold at one store, not tracked, and discontinued',
      should: 'skip each, saying why',
      actual: skipped.map((s) => [s.product.id, s.toLocationId, s.reason]).sort(),
      expected: [
        [paused, dest, 'PAUSED_AT_DESTINATION'],
        [noStats, dest, 'NO_STATS_AT_DESTINATION'],
        [oneStore, null, 'SOLD_AT_ONE_STORE'],
        [service, null, 'NOT_TRACKED'],
        [discontinued, null, 'DISCONTINUED'],
      ].sort(),
    });
  });

  test('the origin\'s first lot out is expired', async () => {
    const { origin, dests: [dest], product, suggest } = await stores();
    await product('Vencido', { [origin]: { lots: [[5, expiry(-10)], [40, expiry(400)]], sold: 90 }, [dest]: { sold: 90, typical: 5 } });
    const [row] = (await suggest()).suggestions;

    assert({
      given: 'an origin whose oldest lot is past its expiry',
      should: 'leave the expired units out of what it can spare, and block the suggestion with how many must be written off first',
      actual: [row.originSellable, row.suggested, row.blocked],
      expected: [40, 14, { reason: 'EXPIRED_FIRST', expiredUnits: 5 }],
    });
  });

  test('the origin\'s first lot out expires within 60 days', async () => {
    const { origin, dests: [dest], product, suggest } = await stores();
    // The destination sells 0.2 a day: 6 before the lot expires in 30 days, and needs max(3, 10) = 10.
    await product('PorVencer', { [origin]: { lots: [[30, expiry(30)], [30, null]] }, [dest]: { sold: 18, typical: 10 } });
    const [row] = (await suggest()).suggestions;

    assert({
      given: 'an origin whose oldest lot expires in 30 days, and a slow destination',
      should: 'cap the suggestion at what the destination sells before then, with the original amount and the days left',
      actual: [row.suggested, row.originalSuggested, row.firstLotDaysToExpiry],
      expected: [6, 10, 30],
    });
  });

  test('a store that sells none before the first lot expires', async () => {
    const { origin, dests: [slow, fast], product, suggest } = await stores(2);
    // The slow store sells 2 in 90 days: ⌊0.02 × 30⌋ = 0 before the lot expires. The fast one sells 0.2 a day: 6.
    await product('PorVencerLento', { [origin]: { lots: [[30, expiry(30)], [30, null]] }, [slow]: { sold: 2, typical: 10 }, [fast]: { sold: 18, typical: 10 } });
    const { suggestions } = await suggest();

    assert({
      given: 'a destination that would sell none of the first lot before it expires, and one that would sell some',
      should: 'suggest nothing for the first and the capped amount for the second',
      actual: suggestions.map((s) => [s.toLocationId, s.suggested]),
      expected: [[fast, 6]],
    });
  });

  test('expired units at the destination', async () => {
    const { origin, dests: [dest], product, suggest } = await stores();
    await product('VencidoAlla', { [origin]: { lots: [[50, null]] }, [dest]: { lots: [[4, expiry(0)], [3, expiry(200)]], sold: 90, typical: 5 } });
    const [row] = (await suggest()).suggestions;

    assert({
      given: 'a destination with 7 units, 4 of them expiring today',
      should: 'count only 3 as sellable there, say 4 are expired, and suggest for the shortfall',
      actual: [row.destSellable, row.destExpired, row.suggested],
      expected: [3, 4, 11],
    });
  });

  test('one destination or some products', async () => {
    const { origin, dests: [first, second], product, suggest } = await stores(2);
    const need = { sold: 90, typical: 5 };
    const a = await product('A', { [origin]: { lots: [[100, null]] }, [first]: need, [second]: need });
    await product('B', { [origin]: { lots: [[100, null]] }, [first]: need, [second]: need });

    assert({
      given: 'a destination, or a product, asked for',
      should: 'suggest only for it',
      actual: [
        (await suggest({ toLocationId: second })).suggestions.map((s) => [s.product.name, s.toLocationId]),
        (await suggest({ productIds: [a] })).suggestions.map((s) => [s.product.name, s.toLocationId]).sort(),
      ],
      expected: [[['A', second], ['B', second]], [['A', first], ['A', second]].sort()],
    });
  });
});
