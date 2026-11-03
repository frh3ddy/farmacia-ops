/**
 * One-time import of each product's box barcode from Square: reads the `upc`
 * of every Square variation mapped to a product and fills Product.gtin (see
 * src/products/gtin-import.ts for what is written). Only reads Square, never
 * writes to it. Catalog sync is migration-only, so after this run barcodes
 * are edited in the app.
 *
 * Usage:
 *   npm run import-gtin-from-square -w apps/api            # dry run: prints what it would save
 *   npm run import-gtin-from-square -w apps/api -- --yes   # saves
 * Against production: railway run npm run import-gtin-from-square -w apps/api [-- --yes]
 */
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { createSquareClient, squareEnvironment } from '../src/square/square-client';
import { isSquareMapping } from '../src/inventory/square-sync';
import { planGtinImport } from '../src/products/gtin-import';

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
    const rows = await prisma.product.findMany({
      select: { id: true, name: true, gtin: true, catalogMappings: { select: { squareVariationId: true, locationId: true } } },
    });
    const products = rows.map((p) => ({
      id: p.id,
      gtin: p.gtin,
      variationIds: p.catalogMappings.filter(isSquareMapping).map((m) => m.squareVariationId),
    }));

    const variationIds = [...new Set(products.flatMap((p) => p.variationIds))];
    const upcByVariation = new Map<string, string>();
    for (let i = 0; i < variationIds.length; i += 1000) {
      const { objects = [] } = await client.catalog.batchGet({ objectIds: variationIds.slice(i, i + 1000) });
      for (const o of objects) {
        if (o.type === 'ITEM_VARIATION' && o.id && o.itemVariationData?.upc) upcByVariation.set(o.id, o.itemVariationData.upc);
      }
    }

    const { updates, conflicts } = planGtinImport(products, upcByVariation);
    const nameOf = new Map(rows.map((p) => [p.id, p.name]));
    console.log(`Products: ${rows.length} · already have a barcode: ${rows.filter((p) => p.gtin).length}`);
    console.log(`Square variations read: ${variationIds.length} · with a upc: ${upcByVariation.size}`);
    console.log(`Would save a barcode on: ${updates.length} · left empty, variations disagree: ${conflicts.length}`);
    for (const c of conflicts) console.log(`  ${nameOf.get(c.productId)} (${c.productId}): ${c.upcs.join(', ')}`);

    if (!save) return console.log('Dry run: nothing saved. Re-run with --yes to save.');
    let saved = 0;
    for (let i = 0; i < updates.length; i += 500) {
      const results = await prisma.$transaction(
        // gtin: null again, so a barcode set in the app since the read is never overwritten
        updates.slice(i, i + 500).map((u) => prisma.product.updateMany({ where: { id: u.productId, gtin: null }, data: { gtin: u.gtin } })),
      );
      saved += results.reduce((sum, r) => sum + r.count, 0);
    }
    console.log(`Saved ${saved} barcodes.`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
