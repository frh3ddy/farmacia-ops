/**
 * Purchase needs (Por pedir): what a store orders from suppliers for itself and
 * for the stores that buy through it, after what it can send them; and, at a
 * store that buys through another, what that store sends or orders for it
 * (see testing/pglite.ts). Default settings: 14 days of cover; 90 sold = 1 a day.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { purchaseNeeds } from './purchase-needs';

let prisma: PrismaService;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
}, 120_000);

afterAll(() => stop?.());

const NOW = new Date('2026-11-21T18:00:00Z');

interface At { stock?: number; sold?: number; typical?: number; weeks?: number; paused?: boolean }

/** A receiving store and one that buys through it (or none), all active, with a way to add products. */
async function stores(o: { linked?: boolean } = {}) {
  await prisma.location.updateMany({ data: { isActive: false } }); // earlier tests' stores aren't destinations
  const location = async (name: string) => (await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name } })).id;
  const hub = await location('Centro');
  const spoke = await location('Norte');
  if (o.linked !== false) await prisma.stockAlertSettings.create({ data: { locationId: spoke, receivingLocationId: hub } });
  const product = async (name: string, at: Record<string, At>) => {
    const { id } = await prisma.product.create({ data: { name } });
    for (const [locationId, a] of Object.entries(at)) {
      if (a.stock) await prisma.inventory.create({ data: { productId: id, locationId, quantity: a.stock, unitCost: 1, receivedAt: new Date('2026-10-01') } });
      await prisma.productStockStats.create({
        data: { productId: id, locationId, windowDays: 90, unitsSold: a.sold ?? 0, weeksWithSales: a.weeks ?? 10, typicalOnHand: a.typical ?? 0, daysAtZero: 0, stockOuts: 0, computedAt: NOW },
      });
      if (a.paused) await prisma.productStoreStatus.create({ data: { productId: id, locationId, pausedAt: NOW, pauseReason: 'OTHER' } });
    }
    return id;
  };
  return { hub, spoke, product, needs: (locationId: string) => purchaseNeeds(prisma, locationId, { now: NOW }) };
}

describe('purchaseNeeds', () => {
  test('a store that buys for itself', async () => {
    const { hub, spoke, product, needs } = await stores({ linked: false });
    const id = await product('Agotado', { [hub]: { sold: 90, typical: 5 } });
    await product('Surtido', { [hub]: { stock: 50, sold: 90, typical: 5 } });

    assert({
      given: 'a store no other buys through, with a regular seller out of stock and one well stocked',
      should: 'order what the alerting one needs for its cover, for itself only',
      actual: await needs(hub),
      expected: {
        receivingLocationId: null, suppliesLocationIds: [],
        rows: [{ product: { id, name: 'Agotado' }, level: 'out', priority: 1, needHere: 14, forOthers: [], toOrderTotal: 14 }],
      },
    });
    assert({ given: 'the other store', should: 'have nothing to order', actual: (await needs(spoke)).rows, expected: [] });
  });

  test('the receiving store', async () => {
    const { hub, spoke, product, needs } = await stores();
    // Centro keeps max(7, 5) = 7 of 20: spares 13 of the 14 Norte needs.
    const spare = await product('Sobra', { [hub]: { stock: 20, sold: 45, typical: 5 }, [spoke]: { sold: 90, typical: 5 } });
    // Out at both: nothing to spare, order for both.
    const both = await product('Ambas', { [hub]: { sold: 90, typical: 5 }, [spoke]: { sold: 45, typical: 5 } });
    // Out here, well stocked at Norte: nothing for Norte.
    const onlyHere = await product('SoloAqui', { [hub]: { sold: 90, typical: 5 }, [spoke]: { stock: 50, sold: 90, typical: 5 } });

    assert({
      given: 'a product only Norte is short of, which Centro can mostly send, one both are out of, and one only Centro is out of',
      should: 'order for itself and what it can\'t send Norte, most urgent first',
      actual: (await needs(hub)).rows.map((r) => [r.product.id, 'needHere' in r && r.needHere, 'forOthers' in r && r.forOthers, 'toOrderTotal' in r && r.toOrderTotal]),
      expected: [
        [both, 14, [{ locationId: spoke, need: 7, fromSpare: 0, toOrder: 7 }], 21],
        [spare, 0, [{ locationId: spoke, need: 14, fromSpare: 13, toOrder: 1 }], 1],
        [onlyHere, 14, [], 14],
      ],
    });
    assert({ given: 'the receiving store', should: 'list the store that buys through it', actual: (await needs(hub)).suppliesLocationIds, expected: [spoke] });
  });

  test('short here without an alert here', async () => {
    const { hub, spoke, product, needs } = await stores();
    // At Centro, under its typical 10 (so a need) but paused, or not a regular seller: no alert there. Norte is out.
    const paused = await product('PausadoAqui', { [hub]: { stock: 5, sold: 9, typical: 10, paused: true }, [spoke]: { sold: 90, typical: 5 } });
    const irregular = await product('IrregularAqui', { [hub]: { stock: 5, sold: 9, typical: 10, weeks: 2 }, [spoke]: { sold: 90, typical: 5 } });
    const rows = (await needs(hub)).rows;
    const row = (id: string) => rows.find((r) => r.product.id === id) as { needHere: number; toOrderTotal: number; forOthers: Array<{ toOrder: number }> };

    assert({
      given: 'products Norte is out of, short of typical at Centro but paused there, or not a regular seller there',
      should: 'order nothing for Centro itself, only Norte\'s part',
      actual: [paused, irregular].map((id) => [row(id).needHere, row(id).toOrderTotal, row(id).forOthers[0].toOrder]),
      expected: [[0, 14, 14], [0, 14, 14]],
    });
  });

  test('a store that buys through another', async () => {
    const { hub, spoke, product, needs } = await stores();
    const spare = await product('Sobra', { [hub]: { stock: 20, sold: 45, typical: 5 }, [spoke]: { sold: 90, typical: 5 } });
    const both = await product('Ambas', { [hub]: { sold: 90, typical: 5 }, [spoke]: { sold: 45, typical: 5 } });
    const r = await needs(spoke);

    assert({
      given: 'Norte, which buys through Centro',
      should: 'say what Centro sends and what it orders for each alerting product, matching Centro\'s view',
      actual: [r.receivingLocationId, r.rows],
      expected: [hub, [
        { product: { id: spare, name: 'Sobra' }, level: 'out', priority: 1, need: 14, receivingSends: 13, receivingOrders: 1 },
        { product: { id: both, name: 'Ambas' }, level: 'out', priority: 0.5, need: 7, receivingSends: 0, receivingOrders: 7 },
      ]],
    });
  });
});
