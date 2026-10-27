/**
 * product-search.ts against a real Postgres engine (PGlite: in-process WASM
 * Postgres, no Docker). Runs the actual migration and the actual query
 * builders, so these tests pin what unit tests on the SQL text cannot:
 * ranking order, the tier-2 fallback, the result cap, and that the query
 * still hits the trigram index.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite, type Extension } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { findSearchMatchIds, searchTokens, normalizeQuery, substringMatchSql } from './product-search';

// tsconfig's commonjs/node10 module resolution can't see package `exports`
// subpaths; Jest's runtime can, so require it and type it via the main entry.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm') as { pg_trgm: Extension };



const MIGRATION = join(__dirname, '../../../../prisma/migrations/20261020120000_add_product_search_trgm/migration.sql');

const PRODUCTS: [id: string, name: string, squareName: string | null, sku: string | null][] = [
  ['paracetamol', 'Paracetamol Tabletas 500 mg', null, '7501001'],
  ['ibuprofeno', 'Ibuprofeno Tabletas 400 mg', 'Ibuprofeno 400', '7501002'],
  ['gel', 'Gel Frío Antiinflamatorio 100 ml', null, '7501003'],
  ['tylenol', 'Tylenol', null, '7501004'],
  ['tylenol-kids', 'Tylenol Infantil Jarabe 120 ml', null, '7501005'],
  ['tipo-tylenol', 'Paracetamol Genérico tipo Tylenol', null, '7501006'],
  ['ib-sku', 'Vendas Elásticas', null, 'IB400'],
  ['ib-kit', 'Kit IB400 Promoción', null, '7501008'],
  ['jarabe-tos', 'Ambroxol Jarabe para la Tos', 'Ambroxol 120 ml', null],
  // Numbers that a naive substring search confuses: a barcode containing
  // "500", a strength that ends in "500", a strength glued to its unit.
  ['para-750', 'Paracetamol Tabletas 750 mg', null, '7501500'],
  ['suero-1500', 'Suero Oral 1500 ml', null, null],
  ['amox-500mg', 'Amoxicilina 500mg Cápsulas', null, null],
];

let db: PGlite;
const run = (sql: Prisma.Sql) => db.query<{ id: string }>(sql.text, sql.values).then((r) => r.rows);
const search = (query: string, locationId?: string) => findSearchMatchIds(query, run, locationId);

beforeAll(async () => {
  db = await PGlite.create({ extensions: { pg_trgm } });
  // Only the columns the search touches — the rest of the schema is irrelevant here.
  await db.exec(`CREATE TABLE "Product" (
    id text PRIMARY KEY, name text NOT NULL, "squareProductName" text, sku text,
    "tracksInventory" boolean NOT NULL DEFAULT true
  )`);
  await db.exec(`CREATE TABLE "Inventory" (id serial PRIMARY KEY, "productId" text NOT NULL, "locationId" text NOT NULL, quantity int NOT NULL)`);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  for (const [id, name, squareName, sku] of PRODUCTS) {
    await db.query(`INSERT INTO "Product" VALUES ($1, $2, $3, $4)`, [id, name, squareName, sku]);
  }
  // Stock ranking: three products that tie on relevance for "naproxeno".
  // FIFO batches per location, like Inventory in production.
  await db.exec(`INSERT INTO "Product" (id, name) VALUES
    ('napro-a', 'Naproxeno Tabletas A'),
    ('napro-bb', 'Naproxeno Tabletas BB')`);
  await db.exec(`INSERT INTO "Product" (id, name, "tracksInventory") VALUES
    ('napro-svc', 'Naproxeno Servicio de Aplicación', false)`);
  await db.exec(`INSERT INTO "Inventory" ("productId", "locationId", quantity) VALUES
    ('napro-a', 'loc-1', 2), ('napro-a', 'loc-1', -2),
    ('napro-bb', 'loc-1', 5),
    ('napro-bb', 'loc-2', 0),
    ('tipo-tylenol', 'loc-1', 10)`);

  // Filler for the result-cap test; shares no words with the products above.
  await db.exec(`INSERT INTO "Product" SELECT 'relleno-' || n, 'Relleno Prueba ' || n, NULL, NULL FROM generate_series(1, 600) n`);
});

afterAll(() => db?.close());

describe('tier 1: substring', () => {
  it('ignores accents and case', async () => {
    expect(await search('GEL FRIO')).toEqual(['gel']);
  });

  it('matches tokens in any order, including partial words', async () => {
    expect(await search('400 ibupro')).toEqual(['ibuprofeno']);
  });

  it('searches the Square name and SKU too', async () => {
    expect(await search('ambroxol 120')).toEqual(['jarabe-tos']);
    expect(await search('7501003')).toEqual(['gel']);
  });

  it('ranks an exact SKU above a name that merely contains it', async () => {
    expect(await search('ib400')).toEqual(['ib-sku', 'ib-kit']);
  });

  it('ranks name-starts-with above contains, then shorter names first', async () => {
    expect(await search('tylenol')).toEqual(['tylenol', 'tylenol-kids', 'tipo-tylenol']);
  });
});

describe('numbers', () => {
  it('matches a number only where a number starts, never inside a barcode', async () => {
    // para-750's barcode 7501500 contains "500"; it is a 750 mg product.
    expect(await search('paracetamol 500')).toEqual(['paracetamol']);
  });

  it('does not match the tail of a larger number', async () => {
    const ids = await search('500');
    expect(ids).toEqual(expect.arrayContaining(['paracetamol', 'amox-500mg']));
    expect(ids).not.toContain('suero-1500');
    expect(ids).not.toContain('para-750');
  });

  it('treats "500mg" and "500 mg" as the same thing', async () => {
    expect((await search('500mg')).sort()).toEqual(['amox-500mg', 'paracetamol']);
  });

  it('still matches while a number is half-typed', async () => {
    expect(await search('paracetamol 50')).toEqual(['paracetamol']);
  });

  it('matches a barcode typed from its start', async () => {
    expect(await search('750150')).toEqual(['para-750']);
  });

  it('never treats a different number as a typo', async () => {
    expect(await search('suero 1600')).toEqual([]);
  });
});

describe('tier 2: typo tolerance', () => {
  it('recovers a substituted letter', async () => {
    expect(await search('parasetamol')).toContain('paracetamol');
  });

  it('recovers a transposition alongside an exact token', async () => {
    expect(await search('ibuprofeon 400')).toEqual(['ibuprofeno']);
  });

  it('gives short tokens no slack — "jel" is not "gel"', async () => {
    expect(await search('jel frio')).toEqual([]);
  });

  it('still returns nothing for a genuinely absent product', async () => {
    expect(await search('aspirina')).toEqual([]);
  });

  it('only runs when the substring tier finds nothing', async () => {
    const calls: Prisma.Sql[] = [];
    const counting = (sql: Prisma.Sql) => (calls.push(sql), run(sql));

    await findSearchMatchIds('tylenol', counting);
    expect(calls).toHaveLength(1);

    calls.length = 0;
    await findSearchMatchIds('parasetamol', counting);
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toContain('word_similarity');
  });
});

describe('stock', () => {
  it('breaks a relevance tie in favour of what is in stock at this location', async () => {
    // Without stock, the shorter "Naproxeno Tabletas A" would come first.
    // The service item tracks no inventory, so it always counts as available.
    expect(await search('naproxeno', 'loc-1')).toEqual(['napro-bb', 'napro-svc', 'napro-a']);
  });

  it("uses this location's stock, not another's", async () => {
    // napro-bb is stocked at loc-1 only; at loc-2 both tablets are out.
    expect(await search('naproxeno', 'loc-2')).toEqual(['napro-svc', 'napro-a', 'napro-bb']);
  });

  it('counts batches that net to zero as out of stock', async () => {
    // napro-a has +2 and -2 at loc-1: rows exist, but nothing to sell.
    const ids = await search('naproxeno', 'loc-1');
    expect(ids.indexOf('napro-a')).toBe(ids.length - 1);
  });

  it('sums every location when none is given', async () => {
    expect(await search('naproxeno')).toEqual(['napro-bb', 'napro-svc', 'napro-a']);
  });

  it('never lifts a weaker match above a stronger one', async () => {
    // tipo-tylenol is the only one in stock but merely contains "tylenol".
    expect(await search('tylenol', 'loc-1')).toEqual(['tylenol', 'tylenol-kids', 'tipo-tylenol']);
  });
});

describe('input safety and limits', () => {
  it('treats LIKE wildcards as plain punctuation, never match-all', async () => {
    expect(await search('%')).toEqual([]);
    expect(await search('_')).toEqual([]);
    expect((await search('jarabe%')).sort()).toEqual(['jarabe-tos', 'tylenol-kids']);
  });

  it('caps results so a broad query cannot drag the whole catalog', async () => {
    expect(await search('relleno')).toHaveLength(500);
  });
});

describe('index', () => {
  it('serves the substring tier — words and numbers — from the trigram index', async () => {
    // If someone edits the query expression so it no longer matches the
    // index expression, Postgres silently falls back to a full scan.
    await db.exec('SET enable_seqscan = off');
    try {
      for (const query of ['tylenol', 'paracetamol 500']) {
        const sql = substringMatchSql(searchTokens(query), normalizeQuery(query));
        const plan = await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values);
        expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('Product_search_trgm_idx');
      }
    } finally {
      await db.exec('SET enable_seqscan = on');
    }
  });
});
