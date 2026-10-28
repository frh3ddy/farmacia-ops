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
});
