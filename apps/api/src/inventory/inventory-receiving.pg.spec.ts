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
    for (const attempt of [{ locationId: norte }, { productId: 'other' }, { quantity: 6 }]) {
      outcomes.push(await service.receiveInventory({ ...request, ...attempt }).then(
        () => 'returned',
        (e: Error) => e.message,
      ));
    }

    assert({
      given: 'the request id resent from another location, for another product, or with another quantity',
      should: 'refuse each instead of returning the original receiving, and add no stock',
      actual: [outcomes, (await prisma.inventory.aggregate({ where: { productId }, _sum: { quantity: true } }))._sum.quantity],
      expected: [Array(3).fill('This clientRequestId was already used for a different receiving'), 5],
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
