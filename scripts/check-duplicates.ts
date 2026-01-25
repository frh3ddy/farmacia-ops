import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function checkDuplicates() {
  console.log('🔍 Running pre-migration safety checks...\n');

  // Check Inventory duplicates
  console.log('Checking Inventory table for duplicates (source = OPENING_BALANCE)...');
  const inventoryDuplicates = await prisma.$queryRaw<Array<{
    productId: string;
    locationId: string;
    source: string | null;
    count: bigint;
  }>>`
    SELECT "productId", "locationId", "source", COUNT(*) as count
    FROM "Inventory"
    WHERE "source" = 'OPENING_BALANCE'
    GROUP BY "productId", "locationId", "source"
    HAVING COUNT(*) > 1
  `;

  if (inventoryDuplicates.length > 0) {
    console.log(`❌ Found ${inventoryDuplicates.length} duplicate groups in Inventory table:`);
    inventoryDuplicates.forEach((dup) => {
      console.log(`   - productId: ${dup.productId}, locationId: ${dup.locationId}, count: ${dup.count}`);
    });
  } else {
    console.log('✅ No duplicates found in Inventory table\n');
  }

  // Check CutoverLock duplicates
  console.log('\nChecking CutoverLock table for duplicates...');
  const cutoverLockDuplicates = await prisma.$queryRaw<Array<{
    locationId: string | null;
    cutoverDate: Date;
    count: bigint;
  }>>`
    SELECT "locationId", "cutoverDate", COUNT(*) as count
    FROM "CutoverLock"
    GROUP BY "locationId", "cutoverDate"
    HAVING COUNT(*) > 1
  `;

  if (cutoverLockDuplicates.length > 0) {
    console.log(`❌ Found ${cutoverLockDuplicates.length} duplicate groups in CutoverLock table:`);
    cutoverLockDuplicates.forEach((dup) => {
      console.log(`   - locationId: ${dup.locationId}, cutoverDate: ${dup.cutoverDate}, count: ${dup.count}`);
    });
  } else {
    console.log('✅ No duplicates found in CutoverLock table\n');
  }

  await prisma.$disconnect();
  await pool.end();

  return {
    hasInventoryDuplicates: inventoryDuplicates.length > 0,
    hasCutoverLockDuplicates: cutoverLockDuplicates.length > 0,
    inventoryDuplicates,
    cutoverLockDuplicates,
  };
}

checkDuplicates()
  .then((result) => {
    if (result.hasInventoryDuplicates || result.hasCutoverLockDuplicates) {
      console.log('\n⚠️  WARNING: Duplicates found. Please resolve them before applying the migration.');
      process.exit(1);
    } else {
      console.log('\n✅ All checks passed! Safe to proceed with migration.');
      process.exit(0);
    }
  })
  .catch((error) => {
    console.error('❌ Error running checks:', error);
    process.exit(1);
  });
