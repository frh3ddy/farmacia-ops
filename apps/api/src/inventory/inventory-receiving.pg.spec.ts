/**
 * Receiving against a real Postgres engine (see testing/pglite.ts).
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryReceivingService } from './inventory-receiving.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let service: InventoryReceivingService;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  service = new InventoryReceivingService(prisma);
}, 120_000);

afterAll(() => stop?.());

const notCutOverMessage = 'Esta sucursal aún no ha hecho su corte. Los movimientos de inventario se podrán registrar cuando termine.';

describe('InventoryReceivingService.receiveInventory cutover (Postgres)', () => {
  test('a location not cut over yet', async () => {
    const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Oriente' } });
    const { id: productId } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });

    const error = await service.receiveInventory({ locationId, productId, quantity: 5, unitCost: 2 })
      .then(() => undefined, (e: Error) => e.message);

    assert({
      given: 'stock received at a location whose cutover has not finished',
      should: 'refuse it, since the cutover would count that stock again',
      actual: [error, await prisma.inventory.count({ where: { productId } })],
      expected: [notCutOverMessage, 0],
    });
  });

  test('a cut-over location', async () => {
    const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Lolita' } });
    await prisma.cutoverLock.create({ data: { locationId, cutoverDate: new Date('2026-09-01') } });
    const { id: productId } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });

    await service.receiveInventory({ locationId, productId, quantity: 5, unitCost: 2 });

    assert({
      given: 'stock received at a cut-over location',
      should: 'add it as a batch',
      actual: (await prisma.inventory.aggregate({ where: { productId }, _sum: { quantity: true } }))._sum.quantity,
      expected: 5,
    });
  });
});

describe('InventoryReceivingService.receiveInventory request ids (Postgres)', () => {
  /** A cut-over location and a product to receive there. */
  async function setup() {
    const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Centro' } });
    await prisma.cutoverLock.create({ data: { locationId, cutoverDate: new Date('2026-09-01') } });
    const { id: productId } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
    return { locationId, productId };
  }

  test('a request id already used for a different receiving', async () => {
    const { locationId, productId } = await setup();
    const clientRequestId = `req-reused-${productId}`;
    await service.receiveInventory({ locationId, productId, quantity: 5, unitCost: 2, clientRequestId });
    const { id: norte } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Norte' } });

    const request = { locationId, productId, quantity: 5, unitCost: 2, clientRequestId };
    const outcomes = [];
    for (const attempt of [{ locationId: norte }, { productId: 'other' }, { quantity: 6 }, { unitCost: 3 }]) {
      outcomes.push(await service.receiveInventory({ ...request, ...attempt }).then(
        () => 'returned',
        (e: Error) => e.message,
      ));
    }

    assert({
      given: 'the request id resent from another location, for another product, with another quantity or another unit cost',
      should: 'refuse each instead of returning the original receiving, and add no stock',
      actual: [outcomes, (await prisma.inventory.aggregate({ where: { productId }, _sum: { quantity: true } }))._sum.quantity],
      expected: [Array(4).fill('This clientRequestId was already used for a different receiving'), 5],
    });
  });

  test('the same replay arriving twice at once', async () => {
    const { locationId, productId } = await setup();
    const request = { locationId, productId, quantity: 5, unitCost: 2, clientRequestId: `req-race-${productId}` };

    const [first, second] = await Promise.all([service.receiveInventory(request), service.receiveInventory(request)]);

    assert({
      given: 'two copies of one offline-queue replay racing',
      should: 'record the receiving once and return it to both',
      actual: [
        second.receiving.id === first.receiving.id,
        (await prisma.inventory.aggregate({ where: { productId }, _sum: { quantity: true } }))._sum.quantity,
      ],
      expected: [true, 5],
    });
  });
});

describe('InventoryReceivingService.receiveInventory input (Postgres)', () => {
  test('a quantity or cost that is not a valid number', async () => {
    const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Centro' } });
    await prisma.cutoverLock.create({ data: { locationId, cutoverDate: new Date('2026-09-01') } });
    const { id: productId } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });

    const outcomes = [];
    for (const attempt of [{ quantity: 1.5 }, { quantity: undefined }, { unitCost: '2' }, { unitCost: NaN }]) {
      outcomes.push(await service.receiveInventory({ locationId, productId, quantity: 5, unitCost: 2, ...attempt } as any).then(
        () => 'received',
        (e: any) => e.status,
      ));
    }

    assert({
      given: 'a fractional or missing quantity, and a unit cost sent as text or NaN',
      should: 'refuse each with a 400 and add no stock',
      actual: [outcomes, await prisma.inventory.count({ where: { productId } })],
      expected: [[400, 400, 400, 400], 0],
    });
  });
});

describe('InventoryReceivingService Square sync (Postgres)', () => {
  test('Square rejecting a receipt, then a retry', async () => {
    const batchCreateChanges = vi.fn()
      .mockResolvedValueOnce({ errors: [{ code: 'SERVICE_UNAVAILABLE', detail: 'Square is down' }] })
      .mockResolvedValue({ counts: [] });
    const synced = new InventoryReceivingService(prisma);
    synced['squareClient'] = { inventory: { batchCreateChanges } } as any;
    const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Sur' } });
    await prisma.cutoverLock.create({ data: { locationId, cutoverDate: new Date('2026-09-01') } });
    const { id: productId } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
    await prisma.catalogMapping.create({ data: { productId, squareVariationId: `v-${productId}` } });

    const { receiving, squareSync } = await synced.receiveInventory({ locationId, productId, quantity: 3, unitCost: 5, syncToSquare: true });
    const afterReceive = await prisma.inventoryReceiving.findUniqueOrThrow({ where: { id: receiving.id } });
    const retry = await synced.retrySquareSync(receiving.id);
    const afterRetry = await prisma.inventoryReceiving.findUniqueOrThrow({ where: { id: receiving.id } });

    assert({
      given: 'a receipt Square rejected, then retried while Square is up',
      should: 'record the failure, then the success, both keyed on the receiving',
      actual: [
        squareSync,
        [afterReceive.squareSynced, afterReceive.squareSyncError],
        retry,
        [afterRetry.squareSynced, afterRetry.squareSyncError, afterRetry.squareSyncedAt instanceof Date],
        batchCreateChanges.mock.calls.map(([r]) => r.idempotencyKey),
      ],
      expected: [
        { synced: false, error: 'Square is down' },
        [false, 'Square is down'],
        { synced: true },
        [true, null, true],
        [receiving.id, receiving.id],
      ],
    });
  });
});

describe('InventoryReceivingService.getReceivingsByProduct (Postgres)', () => {
  test("more of a product's receivings than a list holds", async () => {
    const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Poniente' } });
    const { id: productId } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
    const batchIds = Array.from({ length: 101 }, () => crypto.randomUUID());
    await prisma.inventory.createMany({ data: batchIds.map((id) => ({ id, productId, locationId, quantity: 1, unitCost: 1, receivedAt: new Date('2026-10-01') })) });
    await prisma.inventoryReceiving.createMany({
      data: batchIds.map((inventoryBatchId, i) => ({
        locationId, productId, inventoryBatchId, quantity: 1, unitCost: 1, totalCost: 1,
        receivedAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
      })),
    });

    const listed = await service.getReceivingsByProduct(productId);

    assert({
      given: "101 receivings of one product",
      should: 'list the newest 100',
      actual: [listed.length, listed[0].receivedAt.toISOString()],
      expected: [100, '2026-10-01T01:40:00.000Z'],
    });
  });
});
