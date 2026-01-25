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

async function resolveDuplicates() {
  console.log('🔧 Resolving duplicates before migration...\n');

  // Resolve Inventory duplicates
  console.log('Checking for Inventory duplicates (source = OPENING_BALANCE)...');
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
    console.log(`Found ${inventoryDuplicates.length} duplicate groups in Inventory table. Resolving...`);
    
    for (const dup of inventoryDuplicates) {
      // Find all duplicate records, ordered by createdAt (earliest first)
      const duplicates = await prisma.inventory.findMany({
        where: {
          productId: dup.productId,
          locationId: dup.locationId,
          source: 'OPENING_BALANCE',
        },
        orderBy: {
          createdAt: 'asc',
        },
      });

      if (duplicates.length > 1) {
        // Keep the earliest one, delete the rest
        const toKeep = duplicates[0];
        const toDelete = duplicates.slice(1);

        console.log(`  - Keeping earliest record (id: ${toKeep.id}, createdAt: ${toKeep.createdAt})`);
        console.log(`    Deleting ${toDelete.length} duplicate(s)...`);

        for (const record of toDelete) {
          await prisma.inventory.delete({
            where: { id: record.id },
          });
        }
      }
    }
    console.log('✅ Inventory duplicates resolved\n');
  } else {
    console.log('✅ No Inventory duplicates found\n');
  }

  // Resolve CutoverLock duplicates
  console.log('Checking for CutoverLock duplicates...');
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
    console.log(`Found ${cutoverLockDuplicates.length} duplicate groups in CutoverLock table. Resolving...`);
    
    for (const dup of cutoverLockDuplicates) {
      // Find all duplicate records, ordered by lockedAt (latest first)
      const duplicates = await prisma.cutoverLock.findMany({
        where: {
          locationId: dup.locationId,
          cutoverDate: dup.cutoverDate,
        },
        orderBy: {
          lockedAt: 'desc',
        },
      });

      if (duplicates.length > 1) {
        // Keep the latest one, delete the rest
        const toKeep = duplicates[0];
        const toDelete = duplicates.slice(1);

        console.log(`  - Keeping latest record (id: ${toKeep.id}, lockedAt: ${toKeep.lockedAt})`);
        console.log(`    Deleting ${toDelete.length} duplicate(s)...`);

        for (const record of toDelete) {
          await prisma.cutoverLock.delete({
            where: { id: record.id },
          });
        }
      }
    }
    console.log('✅ CutoverLock duplicates resolved\n');
  } else {
    console.log('✅ No CutoverLock duplicates found\n');
  }

  await prisma.$disconnect();
  await pool.end();

  console.log('✅ All duplicates resolved. Safe to proceed with migration.');
}

resolveDuplicates()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error resolving duplicates:', error);
    process.exit(1);
  });
