/**
 * The stock_alerts migration: default thresholds for every store, and product
 * rows re-sent to the phones when a pause or the alert's inputs change.
 */
import { assert } from 'riteway/vitest';
import { applyMigration, migratedDb } from '../testing/pglite';

const MIGRATION = '20261111120000_stock_alerts';

describe('stock_alerts migration', () => {
  test('settings seeded per store', async () => {
    const db = await migratedDb({ before: MIGRATION });
    await db.exec(`INSERT INTO "Location" (id, name) VALUES ('centro', 'Centro'), ('oriente', 'Oriente')`);
    await applyMigration(db, MIGRATION);
    const { rows } = await db.query(`SELECT "locationId", "windowDays", "coverDays", "regularMinWeeks", "slowMaxUnits", "slowMinDaysAtZero", "equivalentMinUnits" FROM "StockAlertSettings" ORDER BY 1`);
    await db.close();

    assert({
      given: 'two stores before the migration',
      should: 'give each the approved defaults',
      actual: rows,
      expected: ['centro', 'oriente'].map((locationId) => ({
        locationId, windowDays: 90, coverDays: 14, regularMinWeeks: 4, slowMaxUnits: 2, slowMinDaysAtZero: 30, equivalentMinUnits: 3,
      })),
    });
  });

  test('product rows re-sent on alert changes', async () => {
    const db = await migratedDb();
    await db.exec(`
      INSERT INTO "Location" (id, name) VALUES ('centro', 'Centro');
      INSERT INTO "Product" (id, name) VALUES ('p', 'Paracetamol');
      INSERT INTO "ProductStockStats" ("productId", "locationId", "windowDays", "unitsSold", "weeksWithSales", "typicalOnHand", "daysAtZero", "stockOuts", "computedAt")
        VALUES ('p', 'centro', 90, 10, 5, 4, 0, 0, now());
    `);
    const stamp = async () => (await db.query<{ x: string }>(`SELECT "changeXid"::text AS x FROM "Product"`)).rows[0].x;
    const s0 = await stamp();
    await db.exec(`UPDATE "ProductStockStats" SET "computedAt" = now() + interval '1 day', "daysAtZero" = 1`);
    const s1 = await stamp();
    await db.exec(`UPDATE "ProductStockStats" SET "unitsSold" = 11`);
    const s2 = await stamp();
    await db.exec(`INSERT INTO "ProductStoreStatus" ("productId", "locationId", "pausedAt", "pauseReason") VALUES ('p', 'centro', now(), 'OTHER')`);
    const s3 = await stamp();
    await db.close();

    assert({
      given: 'nightly stats rewritten with the same alert inputs, then new units sold, then a pause',
      should: 're-send the product only for the units sold and the pause',
      actual: [s1 === s0, s2 === s1, s3 === s2],
      expected: [true, false, false],
    });
  });

  test('a replacement product removed', async () => {
    const db = await migratedDb();
    await db.exec(`
      INSERT INTO "Location" (id, name) VALUES ('centro', 'Centro');
      INSERT INTO "Product" (id, name) VALUES ('p', 'Paracetamol'), ('g', 'Paracetamol genérico');
      INSERT INTO "ProductStoreStatus" ("productId", "locationId", "pausedAt", "pauseReason", "replacedByProductId")
        VALUES ('p', 'centro', now(), 'REPLACED_BY_EQUIVALENT', 'g');
      DELETE FROM "Product" WHERE id = 'g';
    `);
    const { rows } = await db.query(`SELECT "pauseReason", "replacedByProductId" FROM "ProductStoreStatus"`);
    await db.close();

    assert({
      given: 'a product paused as replaced, and the replacement product deleted',
      should: 'keep the pause and forget the replacement',
      actual: rows,
      expected: [{ pauseReason: 'REPLACED_BY_EQUIVALENT', replacedByProductId: null }],
    });
  });
});
