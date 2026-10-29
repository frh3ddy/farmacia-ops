/**
 * Transfers against a real Postgres engine (see testing/pglite.ts), with
 * Square's inventory call recorded: what Square is told when stock moves
 * between two cut-over locations.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { TransferService } from './transfer.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let centro: string;
let norte: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } }));
  ({ id: norte } = await prisma.location.create({ data: { squareId: 'SQ-NORTE', name: 'Norte' } }));
  await prisma.cutoverLock.createMany({ data: [centro, norte].map((locationId) => ({ locationId, cutoverDate: new Date('2026-09-01') })) });
}, 120_000);

afterAll(() => stop?.());

/** Services sharing one recorded Square client, and a mapped product with 10 units at Centro. */
async function transferSetup() {
  const batchCreateChanges = vi.fn().mockResolvedValue({ counts: [] });
  const square = { inventory: { batchCreateChanges } } as any;
  const adjustments = new InventoryAdjustmentService(prisma);
  adjustments['squareClient'] = square;
  const transfers = new TransferService(prisma, adjustments);
  transfers['squareClient'] = square;

  const product = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
  await prisma.catalogMapping.create({ data: { productId: product.id, squareVariationId: `v-${product.id}` } });
  await prisma.inventory.create({ data: { productId: product.id, locationId: centro, quantity: 10, unitCost: 2, receivedAt: new Date('2026-10-01') } });
  return { transfers, batchCreateChanges, productId: product.id };
}

describe('TransferService (Postgres, Square recorded)', () => {
  test('shipping', async () => {
    const { transfers, batchCreateChanges, productId } = await transferSetup();
    await transfers.ship({ productId, fromLocationId: centro, toLocationId: norte, quantity: 6 });

    assert({
      given: 'stock shipped but not yet received',
      should: 'tell Square nothing yet (no waste at the origin)',
      actual: batchCreateChanges.mock.calls.length,
      expected: 0,
    });
  });

  test('shipping to a location not cut over yet', async () => {
    const { transfers, productId } = await transferSetup();
    const { id: oriente } = await prisma.location.create({ data: { squareId: 'SQ-ORIENTE', name: 'Oriente' } });

    const error = await transfers.ship({ productId, fromLocationId: centro, toLocationId: oriente, quantity: 6 })
      .then(() => undefined, (e: Error) => e.message);

    assert({
      given: 'a transfer to a location whose cutover has not finished',
      should: 'refuse it before taking any stock from the origin',
      actual: [error, (await prisma.inventory.aggregate({ where: { productId }, _sum: { quantity: true } }))._sum.quantity],
      expected: ['Esta sucursal aún no ha hecho su corte. Los movimientos de inventario se podrán registrar cuando termine.', 10],
    });
  });

  test('shipping a quantity that is not a whole number', async () => {
    const { transfers, productId } = await transferSetup();

    const outcomes = [];
    for (const quantity of ['5', 1.5, true] as any[]) {
      outcomes.push(await transfers.ship({ productId, fromLocationId: centro, toLocationId: norte, quantity }).then(
        () => 'shipped',
        (e: any) => e.status,
      ));
    }

    assert({
      given: 'a quantity sent as a string, a fraction or a boolean',
      should: 'refuse each with a 400 before taking any stock from the origin',
      actual: [outcomes, (await prisma.inventory.aggregate({ where: { productId }, _sum: { quantity: true } }))._sum.quantity],
      expected: [[400, 400, 400], 10],
    });
  });

  test('the transfer record failing after the stock was taken', async () => {
    const { transfers, productId } = await transferSetup();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'transfer insert failed'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_transfer BEFORE INSERT ON "Transfer" FOR EACH ROW EXECUTE FUNCTION fail_insert()`);

    const error = await transfers.ship({ productId, fromLocationId: centro, toLocationId: norte, quantity: 6 })
      .then(() => undefined, (e: Error) => e.message);
    await prisma.$executeRawUnsafe(`DROP TRIGGER fail_transfer ON "Transfer"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION fail_insert()`);

    assert({
      given: 'the Transfer insert failing after the origin batches were consumed',
      should: 'roll the consumption back, leaving the origin stock and no TRANSFER_OUT adjustment',
      actual: [
        error?.includes('transfer insert failed'),
        (await prisma.inventory.aggregate({ where: { productId, locationId: centro }, _sum: { quantity: true } }))._sum.quantity,
        await prisma.inventoryAdjustment.count({ where: { productId } }),
      ],
      expected: [true, 10, 0],
    });
  });

  test('receiving less than was shipped', async () => {
    const { transfers, batchCreateChanges, productId } = await transferSetup();
    const { transfer } = await transfers.ship({ productId, fromLocationId: centro, toLocationId: norte, quantity: 6 });
    const [line] = transfer.lines;

    const { squareSync } = await transfers.receive({
      transferId: transfer.id,
      lineReceipts: [{ transferLineId: line.id, quantityReceived: 4 }],
      syncToSquare: true,
    });

    const request = batchCreateChanges.mock.calls[0][0];
    assert({
      given: '6 shipped and 4 received',
      should: 'move the 4 from Centro to Norte and record the 2 lost in transit as waste at Centro, in one call keyed on the transfer',
      actual: [
        batchCreateChanges.mock.calls.length,
        request.idempotencyKey,
        request.changes.map(({ adjustment: a }: any) => [a.fromState, a.toState, a.fromLocationId, a.toLocationId, a.quantity]),
        squareSync,
      ],
      expected: [
        1,
        transfer.id,
        [
          ['IN_STOCK', 'IN_STOCK', 'SQ-CENTRO', 'SQ-NORTE', '4'],
          ['IN_STOCK', 'WASTE', 'SQ-CENTRO', 'SQ-CENTRO', '2'],
        ],
        { synced: true },
      ],
    });
  });

  test('receiving the same transfer twice at once', async () => {
    const { transfers, productId } = await transferSetup();
    const { transfer } = await transfers.ship({ productId, fromLocationId: centro, toLocationId: norte, quantity: 6 });

    const outcomes = await Promise.allSettled([
      transfers.receive({ transferId: transfer.id }),
      transfers.receive({ transferId: transfer.id }),
    ]);

    assert({
      given: 'two receives of one transfer racing (double tap, offline replay)',
      should: 'receive it once and refuse the other, leaving 6 units at Norte',
      actual: [
        outcomes.map((o) => o.status).sort(),
        (await prisma.inventory.aggregate({ where: { productId, locationId: norte }, _sum: { quantity: true } }))._sum.quantity,
      ],
      expected: [['fulfilled', 'rejected'], 6],
    });
  });
});

describe('TransferService.retrySquareSync (Postgres, Square recorded)', () => {
  test('a receipt Square rejected, retried', async () => {
    const { transfers, batchCreateChanges, productId } = await transferSetup();
    const { transfer } = await transfers.ship({ productId, fromLocationId: centro, toLocationId: norte, quantity: 6 });
    batchCreateChanges.mockResolvedValueOnce({ errors: [{ code: 'SERVICE_UNAVAILABLE', detail: 'Square is down' }] });
    await transfers.receive({
      transferId: transfer.id,
      lineReceipts: [{ transferLineId: transfer.lines[0].id, quantityReceived: 4 }],
      syncToSquare: true,
    });
    const afterReceive = await prisma.transfer.findUniqueOrThrow({ where: { id: transfer.id } });

    const result = await transfers.retrySquareSync(transfer.id);
    const afterRetry = await prisma.transfer.findUniqueOrThrow({ where: { id: transfer.id } });
    const [first, retry] = batchCreateChanges.mock.calls.map(([r]) => [
      r.idempotencyKey,
      r.changes.map(({ adjustment: a }: any) => [a.toState, a.fromLocationId, a.toLocationId, a.quantity]),
    ]);

    assert({
      given: 'a receipt whose Square sync failed, then retried while Square is up',
      should: "record the failure, resend the same move and shortfall under the transfer's key, and record the success",
      actual: [
        [afterReceive.squareSynced, afterReceive.squareSyncError],
        retry,
        result,
        [afterRetry.squareSynced, afterRetry.squareSyncError, afterRetry.squareSyncedAt instanceof Date],
      ],
      expected: [
        [false, 'Square is down'],
        first,
        { synced: true },
        [true, null, true],
      ],
    });
  });

  test('transfers that have nothing to retry', async () => {
    const { transfers, batchCreateChanges, productId } = await transferSetup();
    const { transfer: synced } = await transfers.ship({ productId, fromLocationId: centro, toLocationId: norte, quantity: 2 });
    await transfers.receive({ transferId: synced.id, syncToSquare: true });
    const { transfer: notSent } = await transfers.ship({ productId, fromLocationId: centro, toLocationId: norte, quantity: 2 });
    await transfers.receive({ transferId: notSent.id });
    const { transfer: inTransit } = await transfers.ship({ productId, fromLocationId: centro, toLocationId: norte, quantity: 2 });
    batchCreateChanges.mockClear();

    const outcomes = [];
    for (const id of [synced.id, notSent.id, inTransit.id]) {
      outcomes.push(await transfers.retrySquareSync(id).then((r) => r, (e: any) => e.status));
    }

    assert({
      given: 'a synced receipt, a receipt never sent to Square, and a transfer still in transit',
      should: 'report the synced one as synced, refuse the other two with a 400, and call Square for none',
      actual: [outcomes, batchCreateChanges.mock.calls.length],
      expected: [[{ synced: true }, 400, 400], 0],
    });
  });
});

describe('TransferService.receive line receipts (Postgres)', () => {
  test('receipts that do not fit the transfer', async () => {
    const { transfers, productId } = await transferSetup();
    const { transfer } = await transfers.ship({ productId, fromLocationId: centro, toLocationId: norte, quantity: 6 });
    const [line] = transfer.lines;

    const outcomes = [];
    for (const receipt of [
      { transferLineId: 'not-a-line', quantityReceived: 6 },
      { transferLineId: line.id, quantityReceived: -1 },
      { transferLineId: line.id, quantityReceived: 1.5 },
    ]) {
      outcomes.push(await transfers.receive({ transferId: transfer.id, lineReceipts: [receipt] }).then(
        () => 'received',
        (e: any) => e.status,
      ));
    }

    assert({
      given: "a receipt for another transfer's line, a negative quantity and a fractional one",
      should: 'refuse each with a 400 and leave the transfer in transit',
      actual: [outcomes, (await prisma.transfer.findUnique({ where: { id: transfer.id } }))?.status],
      expected: [[400, 400, 400], 'IN_TRANSIT'],
    });
  });
});

describe('TransferService.getTransfers (Postgres)', () => {
  test('more transfers than a list holds', async () => {
    const { productId } = await transferSetup();
    const { id: oriente } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Oriente' } });
    await prisma.transfer.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({
        productId, fromLocationId: centro, toLocationId: oriente, quantity: 1, status: 'RECEIVED' as const,
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
      })),
    });

    const listed = await new TransferService(prisma, {} as any).getTransfers({ locationId: oriente });

    assert({
      given: '101 transfers at a location',
      should: 'list the newest 100',
      actual: [listed.length, listed[0].createdAt.toISOString(), listed[listed.length - 1].createdAt.toISOString()],
      expected: [100, '2026-10-01T01:40:00.000Z', '2026-10-01T00:01:00.000Z'],
    });
  });
});
