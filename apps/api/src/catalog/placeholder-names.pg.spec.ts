/**
 * The placeholder-name rule, in code (catalog sync) and in SQL (the data
 * migration that repairs existing rows) — the two must agree.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { isPlaceholderProductName } from './catalog.service';

jest.setTimeout(60_000);

const MIGRATION = join(__dirname, '../../../../prisma/migrations/20261024120000_fix_placeholder_product_names/migration.sql');

describe('isPlaceholderProductName', () => {
  it.each(['Regular', ' sin variación ', 'Sin variacion', 'No variation', 'Unknown', '', null])('%p is a placeholder', (name) => {
    expect(isPlaceholderProductName(name)).toBe(true);
  });

  it.each(['Insulina Regular', 'Aspirina (Small)', 'Yastas lolita'])('%p is a real name', (name) => {
    expect(isPlaceholderProductName(name)).toBe(false);
  });
});

describe('fix_placeholder_product_names migration', () => {
  it('copies the Square item name over placeholder names only', async () => {
    const db = await PGlite.create();
    await db.exec(`CREATE TABLE "Product" (id text PRIMARY KEY, name text NOT NULL, "squareProductName" text, "manualName" text)`);
    await db.exec(`INSERT INTO "Product" VALUES
      ('regular', 'Regular', 'Testing item', NULL),
      ('sin-var', 'Sin variación', ' Aspirina 500 mg ', NULL),
      ('unknown', 'Unknown', 'Jarabe', NULL),
      ('real', 'Insulina Regular', 'Otra cosa', NULL),
      ('manual', 'Regular', 'Testing item', 'Mi nombre'),
      ('no-square', 'Regular', NULL, NULL),
      ('both-generic', 'Regular', 'Sin variación', NULL)`);

    await db.exec(readFileSync(MIGRATION, 'utf8'));

    const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM "Product" ORDER BY id`);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.name]))).toEqual({
      regular: 'Testing item',
      'sin-var': 'Aspirina 500 mg',
      unknown: 'Jarabe',
      real: 'Insulina Regular',
      manual: 'Regular',
      'no-square': 'Regular',
      'both-generic': 'Regular',
    });
    await db.close();
  });
});
