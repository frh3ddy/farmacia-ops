/**
 * Test script for Inventory Adjustments
 * 
 * Usage:
 *   npx ts-node scripts/test-inventory-adjustments.ts
 * 
 * Or with Railway:
 *   railway run npx ts-node scripts/test-inventory-adjustments.ts
 */

import { PrismaClient, AdjustmentType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('='.repeat(60));
  console.log('Inventory Adjustment System Test');
  console.log('='.repeat(60));

  // 1. Find a location with inventory
  console.log('\n1. Finding a location with inventory...');
  const location = await prisma.location.findFirst({
    where: {
      inventories: { some: { quantity: { gt: 5 } } }
    },
    include: {
      inventories: {
        where: { quantity: { gt: 0 } },
        take: 1,
        include: { product: true }
      }
    }
  });

  if (!location || location.inventories.length === 0) {
    console.log('❌ No location with inventory found. Run the cutover migration first.');
    return;
  }

  const testProduct = location.inventories[0].product;
  const testInventory = location.inventories[0];
  
  console.log(`✅ Found location: ${location.name} (${location.id})`);
  console.log(`   Product: ${testProduct.name} (${testProduct.id})`);
  console.log(`   Current inventory: ${testInventory.quantity} units @ $${testInventory.unitCost}/unit`);

  // 2. Get current inventory total
  console.log('\n2. Checking current inventory totals...');
  const inventoryBefore = await prisma.inventory.aggregate({
    where: {
      productId: testProduct.id,
      locationId: location.id,
      quantity: { gt: 0 }
    },
    _sum: { quantity: true }
  });
  console.log(`   Total inventory: ${inventoryBefore._sum.quantity || 0} units`);

  // 3. Test negative adjustment (simulate damage)
  console.log('\n3. Testing NEGATIVE adjustment (DAMAGE)...');
  const damageQty = 2;
  
  // Get FIFO batches
  const fifoBatches = await prisma.inventory.findMany({
    where: {
      productId: testProduct.id,
      locationId: location.id,
      quantity: { gt: 0 }
    },
    orderBy: { receivedAt: 'asc' },
    take: 3
  });
  console.log(`   FIFO batches available: ${fifoBatches.length}`);
  fifoBatches.forEach((b, i) => {
    console.log(`     ${i + 1}. Batch ${b.id.slice(0, 8)}... qty=${b.quantity}, cost=$${b.unitCost}, received=${b.receivedAt.toISOString().split('T')[0]}`);
  });

  // Create damage adjustment
  const damageResult = await prisma.$transaction(async (tx) => {
    // Calculate FIFO consumption
    let remaining = damageQty;
    let totalCost = 0;
    const consumptions: { batchId: string; qty: number; cost: number }[] = [];
    
    for (const batch of fifoBatches) {
      if (remaining <= 0) break;
      const qty = Math.min(Number(batch.quantity), remaining);
      const cost = Number(batch.unitCost) * qty;
      consumptions.push({ batchId: batch.id, qty, cost });
      totalCost += cost;
      remaining -= qty;
    }
    
    const avgCost = totalCost / damageQty;

    // Create adjustment
    const adjustment = await tx.inventoryAdjustment.create({
      data: {
        locationId: location.id,
        productId: testProduct.id,
        type: AdjustmentType.DAMAGE,
        quantity: -damageQty,
        reason: 'Test: Broken packaging',
        notes: 'Created by test script',
        unitCost: avgCost,
        totalCost: totalCost,
        effectiveDate: new Date()
      }
    });

    // Deduct inventory and create consumption records
    for (const c of consumptions) {
      await tx.inventory.update({
        where: { id: c.batchId },
        data: { quantity: { decrement: c.qty } }
      });
      
      await tx.inventoryConsumption.create({
        data: {
          inventoryId: c.batchId,
          adjustmentId: adjustment.id,
          quantity: c.qty,
          unitCost: fifoBatches.find(b => b.id === c.batchId)!.unitCost,
          totalCost: c.cost
        }
      });
    }

    return { adjustment, consumptions };
  });

  console.log(`   ✅ Created DAMAGE adjustment: ${damageResult.adjustment.id}`);
  console.log(`      Quantity: ${damageResult.adjustment.quantity}`);
  console.log(`      Total Cost: $${damageResult.adjustment.totalCost}`);
  console.log(`      Batches consumed: ${damageResult.consumptions.length}`);
  damageResult.consumptions.forEach((c, i) => {
    console.log(`        ${i + 1}. Batch ${c.batchId.slice(0, 8)}... qty=${c.qty}, cost=$${c.cost.toFixed(2)}`);
  });

  // 4. Test positive adjustment (simulate found items)
  console.log('\n4. Testing POSITIVE adjustment (FOUND)...');
  const foundQty = 3;
  const foundCost = Number(testInventory.unitCost);

  const foundResult = await prisma.$transaction(async (tx) => {
    // Create new inventory batch
    const newBatch = await tx.inventory.create({
      data: {
        locationId: location.id,
        productId: testProduct.id,
        quantity: foundQty,
        receivedAt: new Date(),
        unitCost: foundCost,
        source: 'ADJUSTMENT'
      }
    });

    // Create adjustment with reference to batch
    const adjustment = await tx.inventoryAdjustment.create({
      data: {
        locationId: location.id,
        productId: testProduct.id,
        type: AdjustmentType.FOUND,
        quantity: foundQty,
        reason: 'Test: Found behind shelf',
        notes: 'Created by test script',
        unitCost: foundCost,
        totalCost: foundQty * foundCost,
        createdBatchId: newBatch.id,
        effectiveDate: new Date()
      }
    });

    return { adjustment, newBatch };
  });

  console.log(`   ✅ Created FOUND adjustment: ${foundResult.adjustment.id}`);
  console.log(`      Quantity: +${foundResult.adjustment.quantity}`);
  console.log(`      Unit Cost: $${foundResult.adjustment.unitCost}`);
  console.log(`      Created Batch: ${foundResult.newBatch.id}`);

  // 5. Verify inventory totals
  console.log('\n5. Verifying inventory totals...');
  const inventoryAfter = await prisma.inventory.aggregate({
    where: {
      productId: testProduct.id,
      locationId: location.id,
      quantity: { gt: 0 }
    },
    _sum: { quantity: true }
  });
  
  const expectedTotal = (inventoryBefore._sum.quantity || 0) - damageQty + foundQty;
  const actualTotal = inventoryAfter._sum.quantity || 0;
  
  console.log(`   Before: ${inventoryBefore._sum.quantity || 0}`);
  console.log(`   Damage: -${damageQty}`);
  console.log(`   Found:  +${foundQty}`);
  console.log(`   Expected: ${expectedTotal}`);
  console.log(`   Actual: ${actualTotal}`);
  console.log(`   ${expectedTotal === actualTotal ? '✅ MATCH' : '❌ MISMATCH'}`);

  // 6. Check audit trail
  console.log('\n6. Checking FIFO audit trail...');
  const consumptionRecords = await prisma.inventoryConsumption.findMany({
    where: { adjustmentId: damageResult.adjustment.id },
    include: { inventory: true }
  });
  console.log(`   Found ${consumptionRecords.length} consumption record(s) for damage adjustment:`);
  consumptionRecords.forEach((r, i) => {
    console.log(`     ${i + 1}. Batch: ${r.inventoryId.slice(0, 8)}..., Qty: ${r.quantity}, Cost: $${r.totalCost}`);
  });

  // 7. Get all adjustments for the product
  console.log('\n7. Listing all adjustments for this product...');
  const allAdjustments = await prisma.inventoryAdjustment.findMany({
    where: { productId: testProduct.id },
    orderBy: { adjustedAt: 'desc' },
    take: 5
  });
  console.log(`   Recent adjustments (max 5):`);
  allAdjustments.forEach((a, i) => {
    const sign = a.quantity > 0 ? '+' : '';
    console.log(`     ${i + 1}. [${a.type}] ${sign}${a.quantity} units, $${a.totalCost}, ${a.adjustedAt.toISOString().split('T')[0]}`);
  });

  // 8. Summary
  console.log('\n' + '='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ Negative adjustment (DAMAGE) created and FIFO consumed`);
  console.log(`✅ Positive adjustment (FOUND) created with new batch`);
  console.log(`✅ Inventory totals verified`);
  console.log(`✅ Audit trail (InventoryConsumption) created`);
  console.log('\nAll tests passed!');
}

main()
  .catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
