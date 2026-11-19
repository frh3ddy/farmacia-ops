/**
 * Correcting a receiving's unit cost after it was saved wrong, against a real
 * Postgres engine (see testing/pglite.ts): the batch, what was already sold or
 * lost from it, and the supplier's cost all follow the corrected cost.
 */
import { assert } from 'riteway/vitest';
import { Prisma } from '@prisma/client';
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

const uid = () => `${Date.now()}-${Math.random()}`;
const num = (d: Prisma.Decimal | null | undefined) => (d == null ? null : Number(d));

/** A cut-over store, a supplier and a product, with 10 units received from that supplier at `unitCost`. */
async function received(unitCost = 62.67) {
  const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${uid()}`, name: 'Lolita' } });
  await prisma.cutoverLock.create({ data: { locationId, cutoverDate: new Date('2026-09-01') } });
  const { id: productId } = await prisma.product.create({ data: { name: `Dolprin ${uid()}` } });
  const { id: supplierId } = await prisma.supplier.create({ data: { name: `Prov ${uid()}`, normalizedName: `prov-${uid()}` } });
  const result = await service.receiveInventory({ locationId, productId, supplierId, quantity: 10, unitCost });
  return { locationId, productId, supplierId, receivingId: result.receiving.id, batchId: result.inventoryBatch.id };
}

/** `quantity` units of the batch sold for $50 each, recorded the way the sale worker records it. */
async function sell(r: { locationId: string; productId: string; batchId: string }, quantity: number) {
  const batch = await prisma.inventory.findUniqueOrThrow({ where: { id: r.batchId } });
  const cost = batch.unitCost.mul(quantity);
  const revenue = new Prisma.Decimal(50 * quantity);
  const sale = await prisma.sale.create({
    data: { squareId: `PAY-${uid()}`, locationId: r.locationId, totalRevenue: revenue, totalCost: cost, grossProfit: revenue.sub(cost), createdAt: new Date() },
  });
  const item = await prisma.saleItem.create({ data: { saleId: sale.id, productId: r.productId, quantity, price: 50, cost } });
  await prisma.inventoryConsumption.create({ data: { inventoryId: r.batchId, saleItemId: item.id, quantity, unitCost: batch.unitCost, totalCost: cost } });
  await prisma.inventory.update({ where: { id: r.batchId }, data: { quantity: { decrement: quantity } } });
  return { saleId: sale.id, saleItemId: item.id };
}

/** A negative adjustment of `type` that took `quantity` units from the batch. */
async function takeOut(r: { locationId: string; productId: string; batchId: string }, quantity: number, type: 'DAMAGE' | 'BREAK_BULK_OUT') {
  const batch = await prisma.inventory.findUniqueOrThrow({ where: { id: r.batchId } });
  const cost = batch.unitCost.mul(quantity);
  const adjustment = await prisma.inventoryAdjustment.create({
    data: { locationId: r.locationId, productId: r.productId, type, quantity: -quantity, unitCost: batch.unitCost, totalCost: cost },
  });
  await prisma.inventoryConsumption.create({ data: { inventoryId: r.batchId, adjustmentId: adjustment.id, quantity, unitCost: batch.unitCost, totalCost: cost } });
  await prisma.inventory.update({ where: { id: r.batchId }, data: { quantity: { decrement: quantity } } });
  return adjustment.id;
}

describe('InventoryReceivingService.correctCost', () => {
  test('a receiving nothing was taken from yet', async () => {
    const r = await received();
    await service.correctCost(r.receivingId, 26.71);
    const receiving = await prisma.inventoryReceiving.findUniqueOrThrow({ where: { id: r.receivingId } });
    const batch = await prisma.inventory.findUniqueOrThrow({ where: { id: r.batchId } });

    assert({
      given: 'a receiving saved with the wrong unit cost',
      should: 'save the corrected cost on the receiving, its total and its batch',
      actual: [num(receiving.unitCost), num(receiving.totalCost), num(batch.unitCost)],
      expected: [26.71, 267.1, 26.71],
    });
  });

  test('units already sold from it', async () => {
    const r = await received(62.67);
    const { saleId, saleItemId } = await sell(r, 2);
    await service.correctCost(r.receivingId, 26.71);
    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: saleId } });
    const item = await prisma.saleItem.findUniqueOrThrow({ where: { id: saleItemId } });
    const consumption = await prisma.inventoryConsumption.findFirstOrThrow({ where: { saleItemId } });

    assert({
      given: 'a sale of 2 units for $100 costed at the wrong cost',
      should: "recost the sale's units, its line and its total and profit",
      actual: [num(consumption.unitCost), num(consumption.totalCost), num(item.cost), num(sale.totalCost), num(sale.grossProfit)],
      expected: [26.71, 53.42, 53.42, 53.42, 46.58],
    });
  });

  test('units already lost from it', async () => {
    const r = await received(62.67);
    const adjustmentId = await takeOut(r, 3, 'DAMAGE');
    await service.correctCost(r.receivingId, 26.71);
    const adjustment = await prisma.inventoryAdjustment.findUniqueOrThrow({ where: { id: adjustmentId } });

    assert({
      given: '3 damaged units taken from the batch at the wrong cost',
      should: 'value the loss at the corrected cost',
      actual: [num(adjustment.unitCost), num(adjustment.totalCost)],
      expected: [26.71, 80.13],
    });
  });

  test("the supplier's cost", async () => {
    const r = await received(62.67);
    await service.correctCost(r.receivingId, 26.71);
    const link = await prisma.supplierProduct.findUniqueOrThrow({ where: { supplierId_productId: { supplierId: r.supplierId, productId: r.productId } } });
    const current = await prisma.supplierCostHistory.findMany({ where: { supplierId: r.supplierId, productId: r.productId, isCurrent: true } });

    assert({
      given: "the supplier's latest receiving of the product corrected",
      should: "make the corrected cost the supplier's current cost",
      actual: [num(link.cost), current.map((h) => [num(h.unitCost), h.source])],
      expected: [26.71, [[26.71, 'MANUAL']]],
    });
  });

  test("an older receiving than the supplier's latest", async () => {
    const r = await received(62.67);
    await service.receiveInventory({ locationId: r.locationId, productId: r.productId, supplierId: r.supplierId, quantity: 5, unitCost: 27 });
    await service.correctCost(r.receivingId, 26.71);
    const link = await prisma.supplierProduct.findUniqueOrThrow({ where: { supplierId_productId: { supplierId: r.supplierId, productId: r.productId } } });

    assert({
      given: 'a correction to a receiving older than a later one from the same supplier',
      should: "leave the supplier's current cost at the later receiving's cost",
      actual: num(link.cost),
      expected: 27,
    });
  });

  test('a lot piece split from the batch', async () => {
    const r = await received(62.67);
    const piece = await prisma.inventory.create({
      data: { locationId: r.locationId, productId: r.productId, quantity: 4, receivedAt: new Date(), unitCost: 62.67, splitFromId: r.batchId, splitInitialQuantity: 4 },
    });
    await service.correctCost(r.receivingId, 26.71);

    assert({
      given: 'part of the batch split into its own lot',
      should: 'correct that lot too, since it is the same units',
      actual: num((await prisma.inventory.findUniqueOrThrow({ where: { id: piece.id } })).unitCost),
      expected: 26.71,
    });
  });

  test('units sent to another store, opened into loose units, or returned', async () => {
    const shipped = await received(62.67);
    const { id: oriente } = await prisma.location.create({ data: { squareId: `SQ-${uid()}`, name: 'Oriente' } });
    const transfer = await prisma.transfer.create({ data: { productId: shipped.productId, fromLocationId: shipped.locationId, toLocationId: oriente, quantity: 2 } });
    await prisma.transferLine.create({ data: { transferId: transfer.id, sourceInventoryId: shipped.batchId, quantity: 2, unitCost: 62.67, originalReceivedAt: new Date() } });
    const opened = await received(62.67);
    await takeOut(opened, 1, 'BREAK_BULK_OUT');
    const returned = await received(62.67);
    const { saleId, saleItemId } = await sell(returned, 1);
    const back = await prisma.inventoryAdjustment.create({ data: { locationId: returned.locationId, productId: returned.productId, type: 'RETURN', quantity: 1, unitCost: 62.67, totalCost: 62.67 } });
    const saleReturn = await prisma.saleReturn.create({ data: { saleId, clientRequestId: uid(), revenue: 50, cost: 62.67 } });
    await prisma.saleReturnItem.create({ data: { returnId: saleReturn.id, saleItemId, adjustmentId: back.id, quantity: 1, revenue: 50, cost: 62.67 } });

    const errors = await Promise.all([shipped, opened, returned].map((r) => service.correctCost(r.receivingId, 26.71).then(() => null, (e: Error) => e.message)));
    const costs = await Promise.all([shipped, opened, returned].map(async (r) => num((await prisma.inventory.findUniqueOrThrow({ where: { id: r.batchId } })).unitCost)));

    assert({
      given: 'a batch whose units went to another store, into loose units, or were sold and returned',
      should: 'refuse the correction and change nothing, since those units carry the cost elsewhere',
      actual: [errors.every((e) => e?.startsWith('No se puede corregir')), costs],
      expected: [true, [62.67, 62.67, 62.67]],
    });
  });

  test('the record of who changed it', async () => {
    const r = await received(62.67);
    await sell(r, 2);
    await takeOut(r, 1, 'DAMAGE');
    const { id: employeeId } = await prisma.employee.create({ data: { name: 'Dueño' } });
    await service.correctCost(r.receivingId, 26.71, employeeId);
    const logs = await prisma.auditLog.findMany({ where: { entityType: 'InventoryReceiving', entityId: r.receivingId } });

    assert({
      given: 'a cost corrected by the owner',
      should: 'keep a record of the old and new cost, who changed it, and what it recosted',
      actual: logs.map((l) => [l.action, l.employeeId, l.locationId, l.details]),
      expected: [['CORRECT_RECEIVING_COST', employeeId, r.locationId, { oldUnitCost: '62.67', newUnitCost: '26.71', salesRecosted: 1, adjustmentsRecosted: 1 }]],
    });
  });

  test('a cost that is not a valid number', async () => {
    const r = await received(62.67);
    const errors = await Promise.all([-1, Number.NaN].map((c) => service.correctCost(r.receivingId, c).then(() => null, (e: Error) => e.message)));

    assert({
      given: 'a negative or non-numeric cost',
      should: 'refuse it',
      actual: errors.every(Boolean),
      expected: true,
    });
  });
});
