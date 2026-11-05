/**
 * Conteo inicial (StockCountService) against a real Postgres engine (see
 * testing/pglite.ts): one open count per store, counts as OPENING_COUNT
 * adjustments, the uncounted list and zeroing it.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { StockCountService } from './stock-count.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let counts: StockCountService;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  counts = new StockCountService(prisma, new InventoryAdjustmentService(prisma));
}, 120_000);

afterAll(() => stop?.());

/** A cut-over store. */
async function store() {
  const { id } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Lolita' } });
  await prisma.cutoverLock.create({ data: { locationId: id, cutoverDate: new Date('2026-09-01') } });
  return id;
}

/** A product with one batch of `quantity` at $10 in the store. */
async function product(locationId: string, quantity: number, name = `P-${Math.random()}`) {
  const { id } = await prisma.product.create({ data: { name } });
  await prisma.inventory.create({ data: { productId: id, locationId, quantity, unitCost: 10, receivedAt: new Date('2026-10-01') } });
  return id;
}

const stock = async (productId: string, locationId: string) =>
  (await prisma.inventory.aggregate({ where: { productId, locationId }, _sum: { quantity: true } }))._sum.quantity;

/** 'done', or the refusal's message. */
const outcome = (promise: Promise<unknown>) => promise.then(() => 'done', (e: Error) => e.message);

describe('StockCountService.start', () => {
  test('a second count while one is open', async () => {
    const locationId = await store();
    await counts.start(locationId, 'owner');

    assert({
      given: 'an open count at a store',
      should: 'refuse a second one for that store',
      actual: await outcome(counts.start(locationId, 'owner')),
      expected: 'Ya hay un conteo inicial abierto en esta sucursal',
    });
  });

  test('a new count after the last one ended', async () => {
    const locationId = await store();
    const first = await counts.start(locationId, 'owner');
    await counts.end(first.id, locationId, 'owner');

    assert({
      given: 'the store’s only count ended',
      should: 'start a new one, and report it as the active count',
      actual: await counts.start(locationId, 'owner').then(async (c) => (await counts.active(locationId))?.id === c.id),
      expected: true,
    });
  });
});

describe('StockCountService.recordCount', () => {
  test('a count equal to the stock', async () => {
    const locationId = await store();
    const productId = await product(locationId, 4);
    const { id } = await counts.start(locationId, 'owner');

    const result = await counts.recordCount(id, { locationId, productId, countedQuantity: 4, countedBy: 'e1' });

    assert({
      given: 'a count equal to stock in an open session',
      should: 'save the entry and no adjustment',
      actual: [result.entry.countedQuantity, result.entry.adjustmentId, await prisma.inventoryAdjustment.count({ where: { productId } })],
      expected: [4, null, 0],
    });
    assert({
      given: 'the counted product',
      should: 'count it in the active session',
      actual: (await counts.active(locationId))?.countedProducts,
      expected: 1,
    });
  });

  test('a count lower than the stock', async () => {
    const locationId = await store();
    const productId = await product(locationId, 8);
    const { id } = await counts.start(locationId, 'owner');

    const result = await counts.recordCount(id, { locationId, productId, countedQuantity: 2, countedBy: 'e1' });
    const adjustment = await prisma.inventoryAdjustment.findFirstOrThrow({ where: { productId } });

    assert({
      given: '8 on record and 2 on the shelf',
      should: 'record a Conteo inicial of −6 at FIFO cost',
      actual: [adjustment.type, adjustment.quantity, adjustment.totalCost.toString(), await stock(productId, locationId)],
      expected: ['OPENING_COUNT', -6, '60', 2],
    });
    assert({
      given: 'the same count',
      should: 'keep the stock it replaced on the entry, linked to the adjustment',
      actual: [result.entry.previousQuantity, result.entry.adjustmentId],
      expected: [8, adjustment.id],
    });
  });

  test('the same count sent twice', async () => {
    const locationId = await store();
    const productId = await product(locationId, 8);
    const { id } = await counts.start(locationId, 'owner');

    await counts.recordCount(id, { locationId, productId, countedQuantity: 5, countedBy: 'e1' });
    const replay = await counts.recordCount(id, { locationId, productId, countedQuantity: 5, countedBy: 'e1' });

    assert({
      given: 'a count of 5 replayed after it applied',
      should: 'change nothing more and keep the first adjustment on the entry',
      actual: [await stock(productId, locationId), await prisma.inventoryAdjustment.count({ where: { productId } }), replay.entry.previousQuantity, !!replay.entry.adjustmentId],
      expected: [5, 1, 8, true],
    });
  });

  test('a count retried after a sale landed', async () => {
    const locationId = await store();
    const productId = await product(locationId, 8);
    const { id } = await counts.start(locationId, 'owner');

    const first = await counts.recordCount(id, { locationId, productId, countedQuantity: 5, countedBy: 'e1', clientRequestId: 'req-1' });
    // A sale after the count committed, before the client's retry arrives.
    await prisma.inventory.updateMany({ where: { productId, locationId }, data: { quantity: { decrement: 1 } } });
    const retry = await counts.recordCount(id, { locationId, productId, countedQuantity: 5, countedBy: 'e1', clientRequestId: 'req-1' });

    assert({
      given: 'a count of 5 at 8, a sale, then the same request retried',
      should: 'return the first result and leave the sale’s stock alone',
      actual: [retry.entry.id === first.entry.id, await stock(productId, locationId), await prisma.inventoryAdjustment.count({ where: { productId } })],
      expected: [true, 4, 1],
    });
  });

  test('a count after the session ended', async () => {
    const locationId = await store();
    const productId = await product(locationId, 3);
    const { id } = await counts.start(locationId, 'owner');
    await counts.end(id, locationId, 'owner');

    assert({
      given: 'an ended session',
      should: 'refuse the count and leave the stock',
      actual: [await outcome(counts.recordCount(id, { locationId, productId, countedQuantity: 0, countedBy: 'e1' })), await stock(productId, locationId)],
      expected: ['El conteo inicial ya terminó', 3],
    });
  });
});

describe('A Corrección de Conteo during a Conteo inicial', () => {
  test('sent by a client that does not know the count is open', async () => {
    const locationId = await store();
    const productId = await product(locationId, 8);
    await counts.start(locationId, 'owner');
    const adjustments = new InventoryAdjustmentService(prisma);

    assert({
      given: 'a count correction (by total or by change) at a store with an open Conteo inicial',
      should: 'refuse both, so no migration fix lands in shrinkage, and leave the stock',
      actual: [
        await outcome(adjustments.createAdjustment({ locationId, productId, type: 'COUNT_CORRECTION', countedQuantity: 5 } as any)),
        await outcome(adjustments.createAdjustment({ locationId, productId, type: 'COUNT_CORRECTION', quantity: -3 })),
        await stock(productId, locationId),
      ],
      expected: [
        'Hay un conteo inicial abierto en esta sucursal; registra el conteo ahí',
        'Hay un conteo inicial abierto en esta sucursal; registra el conteo ahí',
        8,
      ],
    });
  });
});

describe('StockCountService.zero', () => {
  test('more products than one request may zero', async () => {
    const locationId = await store();
    const productId = await product(locationId, 2);
    const { id } = await counts.start(locationId, 'owner');
    const ids = [productId, ...Array.from({ length: 100 }, (_, i) => `missing-${i}`)];

    assert({
      given: '101 products in one "Poner en 0" request',
      should: 'refuse it before zeroing any, so the app sends them in chunks',
      actual: [await outcome(counts.zero(id, locationId, ids, 'owner')), await stock(productId, locationId)],
      expected: ['Envía como máximo 100 productos por solicitud', 2],
    });
  });
});

describe('StockCountService.uncounted and zero', () => {
  test('one product counted, two not', async () => {
    const locationId = await store();
    const counted = await product(locationId, 5, 'Contado');
    const small = await product(locationId, 1, 'Aguja');
    const big = await product(locationId, 3, 'Jarabe');
    await product(locationId, 0, 'Agotado');
    const { id } = await counts.start(locationId, 'owner');
    await counts.recordCount(id, { locationId, productId: counted, countedQuantity: 5, countedBy: 'e1' });

    assert({
      given: 'A counted, B and C with stock not counted, D with none',
      should: 'list B and C with units and value, largest value first',
      actual: (await counts.uncounted(id, locationId)).map((r) => [r.productId, r.name, r.units, r.value]),
      expected: [[big, 'Jarabe', 3, '30'], [small, 'Aguja', 1, '10']],
    });

    const zeroed = await counts.zero(id, locationId, [big, small], 'owner');


    assert({
      given: 'both uncounted products zeroed',
      should: 'empty their stock as Conteo inicial and leave the list empty',
      actual: [zeroed.map((z) => z.ok), await stock(big, locationId), await stock(small, locationId), await counts.uncounted(id, locationId)],
      expected: [[true, true], 0, 0, []],
    });
  });
});

describe('StockCountService.zero with a stale list', () => {
  test('a product counted after the owner loaded the list', async () => {
    const locationId = await store();
    const productId = await product(locationId, 6);
    const { id } = await counts.start(locationId, 'owner');
    const list = await counts.uncounted(id, locationId);
    // A manager counts it while the owner's list still shows it.
    await counts.recordCount(id, { locationId, productId, countedQuantity: 4, countedBy: 'manager' });

    const zeroed = await counts.zero(id, locationId, list.map((r) => r.productId), 'owner');

    assert({
      given: 'a product counted at 4 after the No contados list was loaded',
      should: 'skip it, keep the counted stock and say why',
      actual: [zeroed, await stock(productId, locationId)],
      expected: [[{ productId, ok: false, code: 'ALREADY_COUNTED', error: 'Ya se contó en este conteo' }], 4],
    });
  });
});
