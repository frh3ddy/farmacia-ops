/**
 * A store's stock alert settings: read with defaults, changed by the owner,
 * and the phones re-sent the products whose alert they change (see testing/pglite.ts).
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { stockAlertSettingsOf, updateStockAlertSettings } from './stock-alert-settings';

let prisma: PrismaService;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
}, 120_000);

afterAll(() => stop?.());

const store = async (name = 'Ajustes') => (await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name } })).id;
const refusal = (promise: Promise<unknown>) => promise.then(() => 'done', (e: Error) => e.message);

describe('stockAlertSettingsOf', () => {
  test('a store without settings', async () => {
    const locationId = await store();
    assert({
      given: 'a store with no settings row',
      should: 'read the defaults, buying for itself and for no other store',
      actual: await stockAlertSettingsOf(prisma, locationId),
      expected: {
        locationId, windowDays: 90, coverDays: 14, regularMinWeeks: 4, slowMaxUnits: 2, slowMinDaysAtZero: 30, equivalentMinUnits: 3, noSalesMinDays: 180,
        receivingLocationId: null, suppliesLocationIds: [],
      },
    });
  });
});

describe('updateStockAlertSettings', () => {
  test('changing some settings', async () => {
    const locationId = await store();
    await updateStockAlertSettings(prisma, locationId, { coverDays: 21, noSalesMinDays: 120 });
    const s = await stockAlertSettingsOf(prisma, locationId);
    assert({ given: 'a change to two settings', should: 'save those and keep the rest', actual: [s.coverDays, s.noSalesMinDays, s.windowDays], expected: [21, 120, 90] });
  });

  test('the store that receives from suppliers', async () => {
    const hub = await store('Centro');
    const other = await store('Norte');
    await updateStockAlertSettings(prisma, other, { receivingLocationId: hub });
    assert({
      given: 'a store whose supplier orders go through another',
      should: 'say so on that store, and list it on the receiving store',
      actual: [(await stockAlertSettingsOf(prisma, other)).receivingLocationId, (await stockAlertSettingsOf(prisma, hub)).suppliesLocationIds],
      expected: [hub, [other]],
    });

    const closed = await store('Cerrada');
    await updateStockAlertSettings(prisma, closed, { receivingLocationId: hub });
    await prisma.location.update({ where: { id: closed }, data: { isActive: false } });
    assert({ given: 'a store that buys through it and is then closed', should: 'leave the closed store out', actual: (await stockAlertSettingsOf(prisma, hub)).suppliesLocationIds, expected: [other] });
    await prisma.stockAlertSettings.update({ where: { locationId: closed }, data: { receivingLocationId: null } });

    await updateStockAlertSettings(prisma, other, { receivingLocationId: null });
    assert({ given: 'that turned off', should: 'buy for itself again', actual: (await stockAlertSettingsOf(prisma, hub)).suppliesLocationIds, expected: [] });
  });

  test('settings that are refused', async () => {
    const hub = await store('Centro');
    const other = await store('Norte');
    const third = await store('Sur');
    await updateStockAlertSettings(prisma, other, { receivingLocationId: hub });
    assert({
      given: 'a number out of range, not a whole number, itself as receiving store, a store that buys through another, a receiving store pointed elsewhere, and a store id that is not text',
      should: 'refuse each',
      actual: [
        await refusal(updateStockAlertSettings(prisma, hub, { coverDays: 0 })),
        await refusal(updateStockAlertSettings(prisma, hub, { windowDays: 30.5 })),
        await refusal(updateStockAlertSettings(prisma, hub, { receivingLocationId: hub })),
        await refusal(updateStockAlertSettings(prisma, third, { receivingLocationId: other })),
        await refusal(updateStockAlertSettings(prisma, hub, { receivingLocationId: third })),
        await refusal(updateStockAlertSettings(prisma, third, { receivingLocationId: 5 as never })),
      ],
      expected: [
        'coverDays debe ser un número entero entre 1 y 120',
        'windowDays debe ser un número entero entre 28 y 365',
        'Una sucursal no puede recibir por sí misma',
        'Esa sucursal compra a través de otra',
        'Otras sucursales compran a través de esta',
        'Sucursal no válida',
      ],
    });
  });

  test('the phones get the new alert levels', async () => {
    const locationId = await store();
    const { id: productId } = await prisma.product.create({ data: { name: 'Alerta' } });
    await prisma.productStockStats.create({
      data: { productId, locationId, windowDays: 90, unitsSold: 90, weeksWithSales: 10, typicalOnHand: 5, daysAtZero: 0, stockOuts: 0, computedAt: new Date() },
    });
    const stamp = async () => (await prisma.$queryRaw<Array<{ x: string }>>`SELECT "changeXid"::text AS x FROM "Product" WHERE id = ${productId}`)[0].x;
    const before = await stamp();
    await updateStockAlertSettings(prisma, locationId, { noSalesMinDays: 200 });
    const afterOther = await stamp();
    await updateStockAlertSettings(prisma, locationId, { coverDays: 30 });
    const afterCover = await stamp();
    assert({
      given: 'a change to a pause-suggestion threshold, then to the days of cover',
      should: 're-send the store\'s products only for the change that moves their alert',
      actual: [afterOther === before, afterCover === before],
      expected: [true, false],
    });
  });
});
