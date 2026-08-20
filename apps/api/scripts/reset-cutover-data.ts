/**
 * Wipes all cutover/migration test data (Product, Supplier, Inventory,
 * CatalogMapping, CostApproval, Cutover, CutoverLock, ExtractionSession,
 * ExtractionBatch, SupplierProduct, SupplierCostHistory) so a fresh
 * migration can be run from a clean slate. Leaves Location, Employee/User,
 * auth tables, and Category untouched.
 *
 * Does NOT touch Square — the live/sandbox catalog is left as-is.
 *
 * Usage:
 *   npm run reset-cutover-data            # dry run: prints row counts only
 *   npm run reset-cutover-data -- --yes    # actually deletes
 */
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const MODELS_IN_DELETE_ORDER = [
  'inventoryConsumption',
  'inventoryAdjustment',
  'inventoryReceiving',
  'saleItem',
  'sale',
  'placement',
  'inventory',
  'supplierCostHistory',
  'supplierProduct',
  'costApproval',
  'catalogMapping',
  'extractionBatch',
  'extractionSession',
  'cutover',
  'cutoverLock',
  'product',
  'supplier',
] as const;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL not set');

  const host = new URL(connectionString).hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  const force = process.argv.includes('--force');
  if (!isLocal && !force) {
    console.error(
      `Refusing to run: DATABASE_URL host is "${host}", not localhost. ` +
        `This script permanently deletes data. Pass --force if you really mean it.`,
    );
    process.exit(1);
  }

  const dryRun = !process.argv.includes('--yes');
  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  if (dryRun) {
    console.log(`Dry run against ${host} — pass --yes to actually delete.\n`);
    for (const model of MODELS_IN_DELETE_ORDER) {
      const count = await (prisma as any)[model].count();
      console.log(model, count);
    }
    await prisma.$disconnect();
    return;
  }

  console.log(`Deleting against ${host}...`);
  const result = await prisma.$transaction(
    MODELS_IN_DELETE_ORDER.map((model) => (prisma as any)[model].deleteMany()),
  );
  MODELS_IN_DELETE_ORDER.forEach((model, i) => console.log(model, 'deleted:', result[i].count));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('FAILED, transaction rolled back:', e);
  process.exit(1);
});
