/**
 * products-without-cost.ts against a real Postgres engine (PGlite), so the
 * EXISTS / NOT EXISTS / NOT LIKE filters are exercised for real.
 */
import { PGlite } from '@electric-sql/pglite';
import { productsWithoutCostSql } from './products-without-cost';

jest.setTimeout(60_000);

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  // Only the columns the query touches.
  await db.exec(`
    CREATE TABLE "Product" (
      id text PRIMARY KEY, name text NOT NULL, sku text, "squareImageUrl" text,
      "squareDataSyncedAt" timestamp, "tracksInventory" boolean NOT NULL DEFAULT true,
      "isDiscontinued" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "CatalogMapping" (id serial PRIMARY KEY, "productId" text NOT NULL, "squareVariationId" text NOT NULL);
    CREATE TABLE "Inventory" (id serial PRIMARY KEY, "productId" text NOT NULL, quantity int NOT NULL);

    INSERT INTO "Product" (id, name, "squareDataSyncedAt") VALUES
      ('new-older', 'Nuevo A', '2026-10-01'),
      ('new-newer', 'Nuevo B', '2026-10-20'),
      ('costed', 'Ya costeado', NULL),
      ('local-only', 'Solo local', NULL),
      ('unmapped', 'Sin mapeo', NULL);
    INSERT INTO "Product" (id, name, "isDiscontinued") VALUES ('discontinued', 'Descontinuado', true);
    INSERT INTO "Product" (id, name, "tracksInventory") VALUES ('service', 'Servicio Yastás', false);

    INSERT INTO "CatalogMapping" ("productId", "squareVariationId") VALUES
      ('new-older', 'SQ1'), ('new-newer', 'SQ2'), ('costed', 'SQ3'),
      ('local-only', 'local_abc'), ('discontinued', 'SQ4'), ('service', 'SQ5');
    -- A zero-quantity batch still means a cost was recorded.
    INSERT INTO "Inventory" ("productId", quantity) VALUES ('costed', 0);
  `);
});

afterAll(() => db?.close());

it('lists Square-mapped, stock-tracked products with no batches, newest sync first', async () => {
  const { rows } = await db.query<{ id: string }>(productsWithoutCostSql.text, productsWithoutCostSql.values);
  expect(rows.map((r) => r.id)).toEqual(['new-newer', 'new-older']);
});
