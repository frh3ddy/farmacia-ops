/** The expiring list against a real Postgres engine (see testing/pglite.ts): lots read from the batch. */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryAgingService } from './inventory-aging.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let aging: InventoryAgingService;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  aging = new InventoryAgingService(prisma);
}, 120_000);

afterAll(() => stop?.());

/** A month from now, a lot's caducidad inside the default 90 days. */
const soon = () => new Date(Date.now() + 30 * 86_400_000);

describe('InventoryAgingService.getExpiringProducts', () => {
  test('a lot set by a count and a lot from a receiving', async () => {
    const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Lolita' } });
    const { id: productId } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
    const { id: supplierId } = await prisma.supplier.create({ data: { name: "Prov", normalizedName: `prov-${Math.random()}` } });
    await prisma.inventory.create({ data: { productId, locationId, quantity: 4, unitCost: 10, receivedAt: new Date('2026-10-01'), expiryDate: soon(), lotNumber: 'C1' } });
    const received = await prisma.inventory.create({ data: { productId, locationId, quantity: 6, unitCost: 10, receivedAt: new Date('2026-10-02'), expiryDate: soon(), lotNumber: 'R1' } });
    await prisma.inventoryReceiving.create({ data: { productId, locationId, supplierId, quantity: 6, unitCost: 10, totalCost: 60, inventoryBatchId: received.id, expiryDate: soon(), batchNumber: 'R1' } });

    const [product] = (await aging.getExpiringProducts(locationId)).filter((p) => p.productId === productId);

    assert({
      given: 'a counted lot with no receiving and a received lot, both expiring in a month',
      should: 'list both with their units, the received one with its supplier',
      actual: product.batches.map((b) => [b.batchNumber, b.quantity, b.receivingId === null, !!b.supplierName]).sort(),
      expected: [['C1', 4, true, false], ['R1', 6, false, true]],
    });
  });
});
