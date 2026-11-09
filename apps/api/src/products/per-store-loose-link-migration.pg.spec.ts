/**
 * The per_store_loose_link migration's data step: today's shared links become
 * one row per store that sells both products.
 */
import { assert } from 'riteway/vitest';
import { applyMigration, migratedDb } from '../testing/pglite';

const MIGRATION = '20261109120000_per_store_loose_link';

describe('per_store_loose_link migration', () => {
  test('links shared by every store', async () => {
    const db = await migratedDb({ before: MIGRATION });
    await db.exec(`
      INSERT INTO "Location" (id, "squareId", name) VALUES ('centro', 'SQ-C', 'Centro'), ('oriente', 'SQ-O', 'Oriente');
      INSERT INTO "Product" (id, name, "soldOnlyAtLocationId") VALUES
        ('suelto', 'Suelto', NULL),
        ('suelto-oriente', 'Suelto Oriente', 'oriente'),
        ('suelto-centro', 'Suelto Centro', 'centro');
      INSERT INTO "Product" (id, name, "soldOnlyAtLocationId", "looseProductId") VALUES
        ('caja', 'Caja', NULL, 'suelto'),
        ('caja-b', 'Caja B', NULL, 'suelto-oriente'),
        ('caja-centro', 'Caja Centro', 'centro', 'suelto-oriente'),
        ('sin-suelto', 'Sin suelto', NULL, NULL);
    `);
    const stampBefore = await db.query<{ id: string; x: string }>(`SELECT id, "changeXid"::text AS x FROM "Product" WHERE id = 'caja-centro'`);

    await applyMigration(db, MIGRATION);
    const links = await db.query<{ l: string; b: string; s: string }>(
      `SELECT "locationId" AS l, "boxProductId" AS b, "looseProductId" AS s FROM "ProductLooseLink" ORDER BY 2, 1`,
    );
    const stampAfter = await db.query<{ x: string }>(`SELECT "changeXid"::text AS x FROM "Product" WHERE id = 'caja-centro'`);
    const column = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'Product' AND column_name = 'looseProductId'`);
    await db.close();

    assert({
      given: 'boxes linked once for every store, some to sueltos sold at one store only',
      should: 'keep each link at every store selling both, stamp a box that loses its link everywhere, and drop the old column',
      actual: [links.rows.map((r) => [r.b, r.l, r.s]), stampAfter.rows[0].x !== stampBefore.rows[0].x, column.rows.length],
      expected: [
        [
          ['caja', 'centro', 'suelto'],
          ['caja', 'oriente', 'suelto'],
          ['caja-b', 'oriente', 'suelto-oriente'],
        ],
        true,
        0,
      ],
    });
  });
});
