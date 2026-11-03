/**
 * One-time import of each product's box barcode from Square: reads the `upc`
 * of every Square variation mapped to a product and fills Product.gtin (see
 * src/products/gtin-import.ts). Only reads Square, never writes to it.
 * Catalog sync is migration-only, so after this run barcodes are edited in
 * the app.
 *
 * Usage:
 *   npm run import-gtin-from-square -w apps/api            # dry run: prints what it would save
 *   npm run import-gtin-from-square -w apps/api -- --yes   # saves
 * Against production: railway ssh --service api -- npm run import-gtin-from-square -w apps/api
 * (production's database has no public port). Where SSH is blocked, the owner
 * calls POST /products/import-gtin instead.
 */
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { createSquareClient, squareEnvironment } from '../src/square/square-client';
import { importGtinFromSquare } from '../src/products/gtin-import';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL not set');
  const client = createSquareClient();
  if (!client) throw new Error('SQUARE_ACCESS_TOKEN not set');
  const save = process.argv.includes('--yes');
  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    console.log(`Square: ${squareEnvironment()} · DB host: ${new URL(connectionString).hostname} · ${save ? 'SAVING' : 'dry run'}`);
    const result = await importGtinFromSquare(prisma, client, { save });
    console.log(`Products: ${result.products} · already have a barcode: ${result.alreadyHadBarcode}`);
    console.log(`Square variations read: ${result.variationsRead} · with a upc: ${result.variationsWithBarcode}`);
    console.log(`To save: ${result.toSave} · saved: ${result.saved} · left empty, variations disagree: ${result.conflicts.length}`);
    for (const c of result.conflicts) console.log(`  ${c.name} (${c.productId}): ${c.upcs.join(', ')}`);
    if (!save) console.log('Dry run: nothing saved. Re-run with --yes to save.');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
