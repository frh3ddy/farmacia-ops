/**
 * Test script to verify InventoryConsumption audit trail
 * 
 * Run with: npx ts-node scripts/test-inventory-consumption.ts
 * Or: railway run npx ts-node scripts/test-inventory-consumption.ts
 * 
 * Prerequisites:
 * - DATABASE_URL environment variable set
 * - Migration applied (InventoryConsumption table exists)
 * - At least one sale with items processed
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Testing InventoryConsumption Audit Trail\n');
  console.log('='.repeat(60));

  // 1. Check if InventoryConsumption table exists and has data
  console.log('\n📊 Step 1: Check InventoryConsumption table');
  try {
    const consumptionCount = await prisma.inventoryConsumption.count();
    console.log(`   Total consumption records: ${consumptionCount}`);
    
    if (consumptionCount === 0) {
      console.log('   ⚠️  No consumption records yet.');
      console.log('   This is normal if no sales have been processed since migration.');
      console.log('   Process a sale via Square webhook to create records.');
    } else {
      console.log('   ✅ Consumption records exist!');
    }
  } catch (error: any) {
    if (error.code === 'P2021') {
      console.log('   ❌ Table does not exist. Run migration first:');
      console.log('      npx prisma migrate deploy');
      return;
    }
    throw error;
  }

  // 2. Check recent sales and their consumption records
  console.log('\n📊 Step 2: Check recent sales');
  const recentSales = await prisma.sale.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    include: {
      items: {
        include: {
          consumptions: true,
        },
      },
    },
  });

  if (recentSales.length === 0) {
    console.log('   No sales found in database.');
  } else {
    console.log(`   Found ${recentSales.length} recent sales:\n`);
    
    for (const sale of recentSales) {
      const totalConsumptions = sale.items.reduce(
        (sum, item) => sum + item.consumptions.length,
        0
      );
      
      console.log(`   Sale: ${sale.squareId}`);
      console.log(`     Items: ${sale.items.length}`);
      console.log(`     Consumption records: ${totalConsumptions}`);
      console.log(`     Has audit trail: ${totalConsumptions > 0 ? '✅' : '❌ (processed before migration)'}`);
      console.log('');
    }
  }

  // 3. Show sample consumption details
  console.log('📊 Step 3: Sample consumption details');
  const sampleConsumption = await prisma.inventoryConsumption.findFirst({
    include: {
      inventory: {
        select: {
          id: true,
          productId: true,
          receivedAt: true,
          unitCost: true,
          source: true,
        },
      },
      saleItem: {
        select: {
          id: true,
          quantity: true,
          price: true,
          cost: true,
        },
      },
    },
    orderBy: { consumedAt: 'desc' },
  });

  if (sampleConsumption) {
    console.log('\n   Sample consumption record:');
    console.log(`   ID: ${sampleConsumption.id}`);
    console.log(`   Quantity consumed: ${sampleConsumption.quantity}`);
    console.log(`   Unit cost: ${sampleConsumption.unitCost}`);
    console.log(`   Total cost: ${sampleConsumption.totalCost}`);
    console.log(`   Consumed at: ${sampleConsumption.consumedAt.toISOString()}`);
    console.log(`   Batch received at: ${sampleConsumption.inventory.receivedAt.toISOString()}`);
    console.log(`   Batch source: ${sampleConsumption.inventory.source}`);
  } else {
    console.log('   No sample consumption found.');
  }

  // 4. Test reconciliation query
  console.log('\n📊 Step 4: Test reconciliation query');
  const inventoryWithConsumption = await prisma.inventory.findFirst({
    where: {
      consumptions: {
        some: {},
      },
    },
    include: {
      consumptions: true,
      product: {
        select: { name: true },
      },
      location: {
        select: { name: true },
      },
    },
  });

  if (inventoryWithConsumption) {
    const totalConsumed = inventoryWithConsumption.consumptions.reduce(
      (sum, c) => sum + c.quantity,
      0
    );
    
    console.log(`\n   Product: ${inventoryWithConsumption.product.name}`);
    console.log(`   Location: ${inventoryWithConsumption.location.name}`);
    console.log(`   Current quantity: ${inventoryWithConsumption.quantity}`);
    console.log(`   Total consumed (from this batch): ${totalConsumed}`);
    console.log(`   Consumption records: ${inventoryWithConsumption.consumptions.length}`);
  } else {
    console.log('   No inventory with consumption records found.');
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ Test complete!\n');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
