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
        locationId, windowDays: 90, coverDays: 14, regularMinWeeks: 4, slowMaxUnits: 2, slowMinDaysAtZero: 30, equivalentMinUnits: 3, noSalesMinDays: 180, lowMarginPct: 20,
        receivingLocationId: null, suppliesLocationIds: [], receivingReviewed: null,
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

  test('the low margin line', async () => {
    const locationId = await store();
    await updateStockAlertSettings(prisma, locationId, { lowMarginPct: 25 });
    assert({
      given: 'a store that calls a margin low under 25%, then a line of 0% and one over 60%',
      should: 'save the 25 and refuse the others',
      actual: [
        (await stockAlertSettingsOf(prisma, locationId)).lowMarginPct,
        await refusal(updateStockAlertSettings(prisma, locationId, { lowMarginPct: 0 })),
        await refusal(updateStockAlertSettings(prisma, locationId, { lowMarginPct: 61 })),
      ],
      expected: [25, 'lowMarginPct debe ser un número entero entre 1 y 60', 'lowMarginPct debe ser un número entero entre 1 y 60'],
    });
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

describe('the reviewed mark on who receives from suppliers', () => {
  const owner = async () => (await prisma.employee.create({ data: { name: 'Fredy Méndez' } })).id;
  const reviewedOf = async (locationId: string) => (await stockAlertSettingsOf(prisma, locationId)).receivingReviewed;

  test('the owner confirms the choice', async () => {
    const by = await owner();
    const centro = await store('Centro');
    const norte = await store('Norte');
    const closed = await store('Cerrada');
    await prisma.location.update({ where: { id: closed }, data: { isActive: false } });
    const before = Date.now();
    await updateStockAlertSettings(prisma, centro, { receivingReviewed: true }, by);
    const centroMark = await reviewedOf(centro);
    assert({
      given: 'the owner confirming in one store',
      should: 'mark every open store reviewed by that owner, and not a closed store',
      actual: [centroMark?.by, (await reviewedOf(norte))?.by, await reviewedOf(closed), centroMark!.at.getTime() >= before],
      expected: [{ id: by, name: 'Fredy Méndez' }, { id: by, name: 'Fredy Méndez' }, null, true],
    });
    assert({
      given: 'the same confirmation',
      should: 'keep the store buying for itself',
      actual: (await stockAlertSettingsOf(prisma, norte)).receivingLocationId,
      expected: null,
    });
  });

  test('choosing a receiving store', async () => {
    const by = await owner();
    const hub = await store('Centro');
    const other = await store('Norte');
    await updateStockAlertSettings(prisma, other, { receivingLocationId: hub }, by);
    const keptDefault = await store('Sur');
    await updateStockAlertSettings(prisma, keptDefault, { receivingLocationId: null }, by);
    assert({
      given: 'a change to the receiving store, and a PATCH that keeps the default',
      should: 'count each as reviewed',
      actual: [(await reviewedOf(hub))?.by?.id, (await reviewedOf(keptDefault))?.by?.id],
      expected: [by, by],
    });
  });

  test('other changes and bad values', async () => {
    const by = await owner();
    const locationId = await store();
    await updateStockAlertSettings(prisma, locationId, { coverDays: 20 }, by);
    const afterOther = await reviewedOf(locationId);
    assert({
      given: 'a change that does not touch receiving, then a reviewed mark that is not true',
      should: 'leave it unreviewed, and refuse the bad mark',
      actual: [afterOther, await refusal(updateStockAlertSettings(prisma, locationId, { receivingReviewed: false as never }, by))],
      expected: [null, 'receivingReviewed solo puede ser true'],
    });
  });
});
