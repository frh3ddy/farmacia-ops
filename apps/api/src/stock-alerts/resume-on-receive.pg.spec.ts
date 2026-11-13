/**
 * A paused product resumes by itself when its store receives it: a receiving
 * or a received transfer, whatever its stock was. A database trigger, so no
 * write path can skip it (see testing/pglite.ts and the migration
 * 20261113140000_resume_on_receive).
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryReceivingService } from '../inventory/inventory-receiving.service';
import { InventoryAdjustmentService } from '../inventory/inventory-adjustment.service';
import { TransferService } from '../inventory/transfer.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let centro: string;
let oriente: string;
let manager: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-C', name: 'Centro' } }));
  ({ id: oriente } = await prisma.location.create({ data: { squareId: 'SQ-O', name: 'Oriente' } }));
  ({ id: manager } = await prisma.employee.create({ data: { name: 'Gerente' } }));
  await prisma.cutoverLock.createMany({ data: [centro, oriente].map((locationId) => ({ locationId, cutoverDate: new Date('2026-09-01') })) });
}, 120_000);

afterAll(() => stop?.());

/** A product paused at Centro, with 2 units still on the shelf there. */
async function pausedWithStock() {
  const { id } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
  await prisma.inventory.create({ data: { productId: id, locationId: centro, quantity: 2, unitCost: 10, receivedAt: new Date('2026-10-01') } });
  await prisma.productStoreStatus.create({ data: { productId: id, locationId: centro, pausedAt: new Date(), pauseReason: 'SUPPLIER_UNAVAILABLE', pausedByEmployeeId: manager } });
  return id;
}

/** Units received from a supplier at a store, as InventoryReceivingService records them: the batch, then the receiving. */
async function receive(productId: string, locationId: string) {
  const batch = await prisma.inventory.create({ data: { productId, locationId, quantity: 20, unitCost: 10, receivedAt: new Date(), source: 'PURCHASE' } });
  await prisma.inventoryReceiving.create({ data: { productId, locationId, quantity: 20, unitCost: 10, totalCost: 200, inventoryBatchId: batch.id } });
}

/** A transfer from Oriente received at Centro, as TransferService.receive records it: the batch, then the line pointed at it. */
async function receiveTransfer(productId: string) {
  const source = await prisma.inventory.create({ data: { productId, locationId: oriente, quantity: 0, unitCost: 10, receivedAt: new Date('2026-10-01') } });
  const transfer = await prisma.transfer.create({ data: { productId, fromLocationId: oriente, toLocationId: centro, quantity: 5, status: 'IN_TRANSIT' } });
  const line = await prisma.transferLine.create({ data: { transferId: transfer.id, sourceInventoryId: source.id, quantity: 5, unitCost: 10, originalReceivedAt: new Date('2026-10-01') } });
  const batch = await prisma.inventory.create({ data: { productId, locationId: centro, quantity: 5, unitCost: 10, receivedAt: new Date('2026-10-01'), source: 'ADJUSTMENT' } });
  await prisma.transferLine.update({ where: { id: line.id }, data: { quantityReceived: 5, destinationInventoryId: batch.id } });
}

const statusAt = (productId: string, locationId: string) =>
  prisma.productStoreStatus.findUnique({ where: { productId_locationId: { productId, locationId } } });

describe('resume on receive', () => {
  test('a receiving', async () => {
    const id = await pausedWithStock();
    const before = new Date(Date.now() - 1000);
    await receive(id, centro);
    const row = await statusAt(id, centro);

    assert({
      given: 'a product paused at a store with units still on the shelf, then received from a supplier there',
      should: 'resume it as stock received, by no one, now',
      actual: [row?.pausedAt, row?.resumeCause, row?.resumedByEmployeeId, row!.resumedAt! >= before],
      expected: [null, 'STOCK_RECEIVED', null, true],
    });
  });

  test('a received transfer', async () => {
    const id = await pausedWithStock();
    await receiveTransfer(id);
    const row = await statusAt(id, centro);

    assert({
      given: 'a paused product received at its store from another store',
      should: 'resume it as stock received',
      actual: [row?.pausedAt, row?.resumeCause],
      expected: [null, 'STOCK_RECEIVED'],
    });
  });

  test('another store', async () => {
    const id = await pausedWithStock();
    await receive(id, oriente);

    assert({
      given: 'a product paused at Centro, received at Oriente',
      should: 'leave it paused at Centro',
      actual: (await statusAt(id, centro))?.pausedAt !== null,
      expected: true,
    });
  });

  test('stock that came in without a receiving', async () => {
    const id = await pausedWithStock();
    const found = await prisma.inventory.create({ data: { productId: id, locationId: centro, quantity: 1, unitCost: 10, receivedAt: new Date(), source: 'ADJUSTMENT' } });
    await prisma.inventoryAdjustment.create({ data: { productId: id, locationId: centro, type: 'FOUND', quantity: 1, unitCost: 10, totalCost: 10, createdBatchId: found.id } });

    assert({
      given: 'a paused product whose stock went up by an adjustment (Encontrado)',
      should: 'leave it paused',
      actual: (await statusAt(id, centro))?.pausedAt !== null,
      expected: true,
    });
  });

  test('not paused', async () => {
    const { id } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
    await receive(id, centro);

    assert({
      given: 'a product never paused, received at a store',
      should: 'create no pause row',
      actual: await statusAt(id, centro),
      expected: null,
    });
  });

  test('a received transfer line written again', async () => {
    const id = await pausedWithStock();
    await receiveTransfer(id);
    await prisma.productStoreStatus.update({ where: { productId_locationId: { productId: id, locationId: centro } }, data: { pausedAt: new Date(), resumeCause: null, resumedAt: null } });
    const line = await prisma.transferLine.findFirstOrThrow({ where: { transfer: { productId: id } } });
    await prisma.transferLine.update({ where: { id: line.id }, data: { destinationInventoryId: line.destinationInventoryId, quantityReceived: line.quantityReceived } });

    assert({
      given: 'a product paused again after its transfer was received, then that line written again with the same batch',
      should: 'leave it paused: only a line newly pointed at a batch is a delivery',
      actual: (await statusAt(id, centro))?.pausedAt !== null,
      expected: true,
    });
  });

  test('the clock the database runs on', async () => {
    const id = await pausedWithStock();
    await prisma.$executeRawUnsafe(`SET TIME ZONE 'America/Mexico_City'`);
    await receive(id, centro);
    await prisma.$executeRawUnsafe(`SET TIME ZONE 'UTC'`);
    const row = await statusAt(id, centro);

    assert({
      given: 'a database session on Mexico City time when a paused product is received',
      should: 'still record the resume at the real moment (UTC, as the app writes times)',
      actual: Math.abs(row!.resumedAt!.getTime() - Date.now()) < 60_000,
      expected: true,
    });
  });
});

describe('resume on receive, through the receive services', () => {
  const square = { inventory: { batchCreateChanges: vi.fn().mockResolvedValue({ counts: [] }) } } as never;

  test('a receiving, and its resend', async () => {
    const receivings = new InventoryReceivingService(prisma);
    receivings['squareClient'] = square;
    const id = await pausedWithStock();
    await receivings.receiveInventory({ locationId: centro, productId: id, quantity: 10, unitCost: 5, clientRequestId: `rec-${id}` });
    const resumed = (await statusAt(id, centro))?.pausedAt;
    await prisma.productStoreStatus.update({ where: { productId_locationId: { productId: id, locationId: centro } }, data: { pausedAt: new Date() } });
    await receivings.receiveInventory({ locationId: centro, productId: id, quantity: 10, unitCost: 5, clientRequestId: `rec-${id}` });

    assert({
      given: 'a paused product received through the receiving service, paused again, then the same receiving resent by the phone',
      should: 'resume it on the receiving, and leave the new pause alone on the resend (nothing new was received)',
      actual: [resumed, (await statusAt(id, centro))?.pausedAt !== null],
      expected: [null, true],
    });
  });

  test('a transfer with two lots', async () => {
    const adjustments = new InventoryAdjustmentService(prisma);
    adjustments['squareClient'] = square;
    const transfers = new TransferService(prisma, adjustments);
    transfers['squareClient'] = square;
    const id = await pausedWithStock();
    await prisma.inventory.createMany({
      data: [
        { productId: id, locationId: oriente, quantity: 3, unitCost: 10, receivedAt: new Date('2026-10-01') },
        { productId: id, locationId: oriente, quantity: 3, unitCost: 12, receivedAt: new Date('2026-10-05') },
      ],
    });
    const { transfer } = await transfers.ship({ productId: id, fromLocationId: oriente, toLocationId: centro, quantity: 5 });
    await transfers.receive({ transferId: transfer.id });
    const row = await statusAt(id, centro);

    assert({
      given: 'a paused product sent from another store in two lots and received through the transfer service',
      should: 'resume it as stock received',
      actual: [row?.pausedAt, row?.resumeCause],
      expected: [null, 'STOCK_RECEIVED'],
    });
  });
});
