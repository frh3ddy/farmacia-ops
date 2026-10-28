import { Job } from 'bullmq';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { getSquareClient } from './square-client';
import {
  InsufficientInventoryError,
  DatabaseTransactionError,
  SaleValidationError,
  UnmappedVariationError,
} from './errors';
import { mapVariationToProduct, type MappedProduct } from './catalog.mapper';
import { toSaleLines } from './sale-lines';
import { consumeBatchesFifo, type ConsumedBatch, type FifoConsumptionResult } from './fifo';
import { debugLog } from './debug-log';

// Lazy initialization of database connection (env vars loaded by worker.ts first)
let pool: Pool | null = null;
let prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!prisma) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    // Explicit pool sizing — see prisma.service.ts for rationale. Default
    // headroom here is sized above the sales-queue concurrency (5, see
    // worker.config.ts) so a full batch of concurrent jobs never queues
    // waiting on a connection.
    pool = new Pool({
      connectionString,
      max: Number(process.env.WORKER_DATABASE_POOL_MAX) || 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // An idle connection dropped by the server (restart, failover) emits
    // 'error' on the pool; unhandled, it crashes the worker. The pool
    // replaces the connection on the next query.
    pool.on('error', (error) => console.error('[SALE_WORKER] Idle database connection lost:', error.message));
    const adapter = new PrismaPg(pool);
    prisma = new PrismaClient({ adapter });
    debugLog('[DEBUG] [SALE_WORKER] Prisma client initialized');
  }
  return prisma;
}

// ============================================================================
// Type Definitions
// ============================================================================

interface SaleItemOutput {
  id: string;
  saleId: string;
  productId: string;
  quantity: number;
  price: Prisma.Decimal;
  cost: Prisma.Decimal;
}

interface SaleTotals {
  totalRevenue: Prisma.Decimal;
  totalCost: Prisma.Decimal;
  grossProfit: Prisma.Decimal;
}

// ============================================================================
// Core FIFO Functions
// ============================================================================

/**
 * Resolve a cost basis for a product with no (or insufficient) inventory,
 * so a shortfall can be auto-covered instead of failing the sale. Ported
 * from InventoryAdjustmentService.getLastKnownCost
 * (apps/api/src/inventory/inventory-adjustment.service.ts) — same 3-tier
 * fallback, same DB — the worker can't import the api package directly.
 */
async function getLastKnownCost(
  productId: string,
  locationId: string,
  client: Prisma.TransactionClient,
): Promise<Prisma.Decimal | null> {
  const supplierProduct = await client.supplierProduct.findFirst({
    where: { productId, isPreferred: true },
    orderBy: { cost: 'desc' },
  });
  if (supplierProduct) return supplierProduct.cost;

  const lastBatch = await client.inventory.findFirst({
    where: { productId, locationId },
    orderBy: { receivedAt: 'desc' },
  });
  if (lastBatch) return lastBatch.unitCost;

  const approval = await client.costApproval.findFirst({
    where: { productId, migrationStatus: 'APPROVED' },
    orderBy: { approvedAt: 'desc' },
  });
  return approval ? approval.approvedCost : null;
}

/**
 * Calculate FIFO cost for a sale item by consuming inventory batches in chronological order
 * FIFO ordering is mandatory: always order by receivedAt ASC, never by createdAt
 */
async function calculateFIFOCost(
  productId: string,
  locationId: string,
  quantitySold: number,
  squareId: string,
  client: Prisma.TransactionClient,
): Promise<FifoConsumptionResult> {
  // Step 1: Query inventory batches (FIFO order - NON-NEGOTIABLE)
  const batches = await client.inventory.findMany({
    where: {
      productId: productId,
      locationId: locationId,
      quantity: { gt: 0 },
    },
    orderBy: {
      receivedAt: 'asc', // FIFO ordering - NON-NEGOTIABLE
    },
  });

  // Step 2 & 3: Consume batches oldest-first (pure logic, see fifo.ts)
  const result = consumeBatchesFifo(batches, quantitySold);

  // Step 4: Validate sufficient inventory. If short, Square already
  // processed the payment — the item was physically sold, so the
  // inventory count is what's wrong, not the sale. Auto-cover the
  // shortfall (at a real cost basis) instead of losing the sale, leaving
  // the exact same audit trail a human-entered adjustment would.
  if (result.remainingQuantity > 0) {
    const shortfall = result.remainingQuantity;
    const unitCost = await getLastKnownCost(productId, locationId, client);

    if (unitCost) {
      const coveringBatch = await client.inventory.create({
        data: {
          productId,
          locationId,
          quantity: shortfall,
          receivedAt: new Date(), // newest batch — FIFO exhausts real stock first, by construction
          unitCost,
          source: 'ADJUSTMENT',
        },
      });
      await client.inventoryAdjustment.create({
        data: {
          locationId,
          productId,
          type: 'AUTO_SALE_COVER',
          quantity: shortfall,
          unitCost,
          totalCost: unitCost.mul(shortfall),
          createdBatchId: coveringBatch.id,
          reason: 'Auto-covered to fulfill a Square sale that exceeded recorded stock',
          notes: `squareId=${squareId}`,
          adjustedBy: 'SYSTEM',
          effectiveDate: new Date(),
        },
      });
      debugLog(
        `[DEBUG] Auto-covered shortfall of ${shortfall} for product ${productId} at ${locationId} — created batch ${coveringBatch.id} @ ${unitCost.toString()}`,
      );
      // Re-run FIFO consumption with the covering batch included — exhausts
      // it exactly, remainingQuantity becomes 0.
      return consumeBatchesFifo([...batches, coveringBatch], quantitySold);
    }

    // No cost basis anywhere — fail exactly as before (unpriced/never-received product).
    const available = quantitySold - result.remainingQuantity;
    throw new InsufficientInventoryError(
      productId,
      locationId,
      quantitySold,
      available,
      result.remainingQuantity,
    );
  }

  return result;
}

/**
 * Atomically decrement inventory batches consumed in FIFO cost calculation
 */
async function deductInventory(
  consumedBatches: ConsumedBatch[],
  client: Prisma.TransactionClient,
): Promise<void> {
  if (consumedBatches.length === 0) {
    return;
  }

  // Single batched UPDATE via a VALUES join instead of one sequential
  // round-trip per consumed batch. A sale item touching several FIFO
  // batches previously serialized N awaits inside the held DB transaction;
  // this does it in one statement regardless of how many batches are hit.
  const rows = Prisma.join(
    consumedBatches.map(
      (b) => Prisma.sql`(${b.batchId}::text, ${b.quantityConsumed}::int)`,
    ),
    ', ',
  );

  const updated = await client.$queryRaw<Array<{ id: string; quantity: number }>>(
    Prisma.sql`
      UPDATE "Inventory" AS inv
      SET quantity = inv.quantity - v.qty
      FROM (VALUES ${rows}) AS v(id, qty)
      WHERE inv.id = v.id
      RETURNING inv.id, inv.quantity
    `,
  );

  // Validate quantity doesn't go negative (database constraint should enforce)
  const negative = updated.filter((row) => row.quantity < 0);
  if (negative.length > 0) {
    throw new DatabaseTransactionError(
      `Inventory quantity went negative for batch(es): ` +
        negative.map((row) => `${row.id} (${row.quantity})`).join(', '),
    );
  }
}

/**
 * Process a single sale item: calculate FIFO cost, deduct inventory, create SaleItem record
 * All operations must be in a transaction (handled by caller)
 *
 * FIFO AUDIT TRAIL: Records which inventory batches were consumed in InventoryConsumption table
 */
async function processSaleItem(
  saleId: string,
  productId: string,
  locationId: string,
  quantitySold: number,
  salePrice: Prisma.Decimal | string | number,
  squareId: string,
  client: Prisma.TransactionClient,
): Promise<SaleItemOutput> {
  // Step 1: Calculate FIFO cost (this queries inventory)
  const costResult = await calculateFIFOCost(productId, locationId, quantitySold, squareId, client);

  // Step 2: Deduct inventory (atomic update)
  await deductInventory(costResult.consumedBatches, client);

  // Step 3: Create immutable SaleItem snapshot
  const saleItem = await client.saleItem.create({
    data: {
      saleId: saleId,
      productId: productId,
      quantity: quantitySold,
      price: salePrice,
      cost: costResult.totalCost, // Immutable - never recalculated
    },
  });

  // Step 4: Record consumption in audit trail (FIFO traceability)
  // This creates an immutable record of which batches were consumed for this sale
  await recordInventoryConsumption(saleItem.id, costResult.consumedBatches, client);

  return {
    id: saleItem.id,
    saleId: saleItem.saleId,
    productId: saleItem.productId,
    quantity: saleItem.quantity,
    price: saleItem.price,
    cost: saleItem.cost,
  };
}

/**
 * Record inventory consumption for FIFO audit trail
 * Creates immutable records linking sale items to consumed inventory batches
 * 
 * This is critical for:
 * - Audit compliance (traceability of cost calculations)
 * - Reconciliation (verify inventory matches consumption history)
 * - COGS analysis (detailed cost breakdown by batch)
 */
async function recordInventoryConsumption(
  saleItemId: string,
  consumedBatches: ConsumedBatch[],
  client: Prisma.TransactionClient,
): Promise<void> {
  // Batch fetch unit costs for all consumed batches
  const batchIds = consumedBatches.map(b => b.batchId);
  const inventoryBatches = await client.inventory.findMany({
    where: { id: { in: batchIds } },
    select: { id: true, unitCost: true },
  });
  
  const unitCostMap = new Map(inventoryBatches.map(b => [b.id, b.unitCost]));

  // Create consumption records
  const consumptionRecords = consumedBatches.map(batch => {
    const unitCost = unitCostMap.get(batch.batchId) || new Prisma.Decimal(0);
    return {
      inventoryId: batch.batchId,
      saleItemId: saleItemId,
      quantity: batch.quantityConsumed,
      unitCost: unitCost,
      totalCost: batch.costContribution,
    };
  });

  // Batch insert all consumption records
  if (consumptionRecords.length > 0) {
    await client.inventoryConsumption.createMany({
      data: consumptionRecords,
    });
    
    debugLog(
      `[FIFO_AUDIT] Recorded ${consumptionRecords.length} consumption records for saleItem ${saleItemId}`,
    );
  }
}

/**
 * Calculate total revenue, total cost, and gross profit for a sale.
 * Custom amounts add revenue only: their cost is pending until matched.
 */
function calculateSaleTotals(saleItems: SaleItemOutput[], customLines: Array<{ amount: Prisma.Decimal }>): SaleTotals {
  let totalRevenue = customLines.reduce((sum, l) => sum.add(l.amount), new Prisma.Decimal(0));
  let totalCost = new Prisma.Decimal(0);

  for (const saleItem of saleItems) {
    const itemRevenue = new Prisma.Decimal(saleItem.price).mul(saleItem.quantity);
    totalRevenue = totalRevenue.add(itemRevenue);
    totalCost = totalCost.add(saleItem.cost);
  }

  const grossProfit = totalRevenue.sub(totalCost);

  return {
    totalRevenue: totalRevenue,
    totalCost: totalCost,
    grossProfit: grossProfit,
  };
}

// ============================================================================
// Main Worker Function
// ============================================================================

/**
 * Main worker entry point: process Square payment webhook and create sale with FIFO COGS
 */
export async function processSaleJob(job: Job): Promise<void> {
  debugLog('[DEBUG] ========================================');
  debugLog('[DEBUG] Starting processSaleJob');
  debugLog('[DEBUG] Job ID:', job.id);
  debugLog('[DEBUG] Job data:', JSON.stringify(job.data, null, 2));
  
  // Extract payload from job data
  if (!job.data) {
    console.error('[DEBUG] ERROR: job.data is missing');
    throw new SaleValidationError('Job data is missing', { jobId: job.id });
  }
  
  const { payload } = job.data;
  debugLog('[DEBUG] Extracted payload:', JSON.stringify(payload, null, 2));

  if (!payload) {
    console.error('[DEBUG] ERROR: payload is missing from job.data');
    throw new SaleValidationError(
      'Missing payload in job data',
      { jobData: JSON.stringify(job.data) },
    );
  }

  // Phase 1: Validation & Idempotency
  // Extract payment from job.data.payload.object
  // Note: Square webhook structure is: event.data.object.payment
  // But queue sends: payload = event.data, so payload.object.payment
  debugLog('[DEBUG] Attempting to extract payment from payload.object');
  debugLog('[DEBUG] payload?.object:', JSON.stringify(payload?.object, null, 2));
  debugLog('[DEBUG] payload?.object?.payment:', JSON.stringify(payload?.object?.payment, null, 2));
  
  // Try payload.object.payment first (Square webhook structure)
  // This handles: event.data.object.payment (Square webhook) -> payload.object.payment (after queue)
  // Also handle case where payload itself might be the payment object
  let payment: any = null;
  
  if (payload?.object?.payment) {
    payment = payload.object.payment;
    debugLog('[DEBUG] Found payment at payload.object.payment');
  } else if (payload?.object && typeof payload.object === 'object' && 'id' in payload.object) {
    // payload.object might be the payment directly
    payment = payload.object;
    debugLog('[DEBUG] Found payment at payload.object');
  } else if (payload && typeof payload === 'object' && 'id' in payload && 'location_id' in payload) {
    // payload itself might be the payment
    payment = payload;
    debugLog('[DEBUG] Found payment at payload (direct)');
  }
  
  debugLog('[DEBUG] Final extracted payment:', JSON.stringify(payment, null, 2));

  if (!payment) {
    console.error('[DEBUG] ERROR: Payment object is missing');
    throw new SaleValidationError(
      'Missing payment object in payload',
      { payload: JSON.stringify(payload), jobData: JSON.stringify(job.data) },
    );
  }

  debugLog('[DEBUG] Validating payment object fields...');
  
  if (typeof payment !== 'object') {
    console.error('[DEBUG] ERROR: Payment is not a valid object');
    throw new SaleValidationError(
      'Payment is not a valid object',
      { payment: JSON.stringify(payment) },
    );
  }
  
  if (!payment.id) {
    console.error('[DEBUG] ERROR: Payment object missing id');
    throw new SaleValidationError(
      'Payment object missing id',
      { payment: JSON.stringify(payment) },
    );
  }
  debugLog('[DEBUG] ✓ Payment ID found:', payment.id);

  if (!payment.location_id) {
    console.error('[DEBUG] ERROR: Payment object missing location_id');
    throw new SaleValidationError(
      'Payment object missing location_id',
      { payment: JSON.stringify(payment) },
    );
  }
  debugLog('[DEBUG] ✓ Location ID found:', payment.location_id);

  const squareId = payment.id;
  const locationId = payment.location_id;
  const orderId = payment.order_id;
  const createdAt = payment.created_at
    ? new Date(payment.created_at)
    : new Date();

  debugLog('[DEBUG] Payment details extracted:', {
    squareId,
    locationId,
    orderId,
    createdAt: createdAt.toISOString(),
  });

  // Check if sale with squareId already exists (idempotency)
  debugLog('[DEBUG] Checking for existing sale with squareId:', squareId);
  const existing = await getPrisma().sale.findUnique({
    where: { squareId },
  });
  if (existing) {
    debugLog(`[DEBUG] Sale ${squareId} already exists, skipping (idempotent)`);
    return;
  }
  // A purely-Yastás order never creates a Sale row, so the check above can't
  // catch a redelivered webhook for it — check YastasOperation too.
  const existingYastasOp = await getPrisma().yastasOperation.findFirst({
    where: { squareId },
  });
  if (existingYastasOp) {
    debugLog(`[DEBUG] YastasOperation ${squareId} already exists, skipping (idempotent)`);
    return;
  }
  debugLog('[DEBUG] ✓ No existing sale found, proceeding...');

  // Phase 2: Fetch Order Data from Square (or use test data)
  debugLog('[DEBUG] Validating order_id...');
  if (!orderId) {
    console.error('[DEBUG] ERROR: Payment object missing order_id');
    throw new SaleValidationError(
      'Payment object missing order_id',
      { payment: JSON.stringify(payment) },
    );
  }
  debugLog('[DEBUG] ✓ Order ID found:', orderId);

  let order;
  
  // Check if this is a test event with embedded order data
  const testOrderData = job.data?.payload?._testOrderData;
  if (testOrderData) {
    debugLog('[DEBUG] Using test order data (bypassing Square API)');
    order = testOrderData;
  } else {
    try {
      debugLog('[DEBUG] Fetching order from Square API...');
      const client = getSquareClient();
      debugLog('[DEBUG] Square client initialized, calling orders.get()');
      const response = await client.orders.get({
        orderId: orderId,
      });
      debugLog('[DEBUG] Square API response received');
      order = response.order;

      if (!order) {
        console.error('[DEBUG] ERROR: Order not found in Square response');
        throw new SaleValidationError(
          `Order ${orderId} not found in Square`,
          { orderId, squareId },
        );
      }
      debugLog('[DEBUG] ✓ Order fetched successfully, order ID:', order.id);
    } catch (error) {
      console.error('[DEBUG] ERROR: Failed to fetch order from Square:', {
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        orderId,
        squareId,
      });
      throw new SaleValidationError(
        `Failed to fetch order from Square: ${error instanceof Error ? error.message : String(error)}`,
        { orderId, squareId },
      );
    }
  }

  // Extract line items from order
  debugLog('[DEBUG] Extracting line items from order...');
  const orderLineItems = order.lineItems || [];
  debugLog('[DEBUG] Found', orderLineItems.length, 'line items in order');

  if (!orderLineItems || orderLineItems.length === 0) {
    console.error('[DEBUG] ERROR: Order has no line items');
    throw new SaleValidationError(
      'Order has no line items',
      { orderId, squareId, locationId },
    );
  }

  // Resolve each catalog item's product; an unmapped one fails the sale
  // (the catalog sync creates the mapping, then the retry succeeds).
  const mappings = new Map<string, MappedProduct>();
  for (const { catalogObjectId } of orderLineItems) {
    if (!catalogObjectId || mappings.has(catalogObjectId)) continue;
    try {
      mappings.set(catalogObjectId, await mapVariationToProduct(catalogObjectId, locationId, getPrisma()));
    } catch (error) {
      if (error instanceof UnmappedVariationError) {
        throw new SaleValidationError(
          `Square variation is not mapped to a product. Variation ID: ${error.squareVariationId}, Location ID: ${error.locationId}. ` +
            `Please run catalog sync to create mappings.`,
          { variationId: error.squareVariationId, locationId: error.locationId, orderId, squareId },
        );
      }
      throw error;
    }
  }

  const { saleItems: lineItems, yastasLines: yastasLineItems, customLines } = toSaleLines(orderLineItems, mappings, {
    orderId,
    squareId,
    locationId,
  });
  debugLog('[DEBUG] Total line items mapped:', lineItems.length, 'Yastás line items:', yastasLineItems.length);

  // Phase 3 & 4: Create Sale Record and Process Items (all in transaction)
  debugLog('[DEBUG] Starting transaction to create sale and process items...');
  let saleId: string | null;
  let itemCount: number;

  try {
    const result = await getPrisma().$transaction(
      async (tx) => {
        // Find or create Location based on Square location ID
        let location = await tx.location.findUnique({
          where: { squareId: locationId },
        });

        if (!location) {
          debugLog('[DEBUG] [TX] Location not found, creating new location with squareId:', locationId);
          // Fetch location details from Square API if needed, or create with minimal data
          // For now, create with squareId only - name/address can be updated later
          location = await tx.location.create({
            data: {
              squareId: locationId,
              name: `Location ${locationId}`, // Temporary name, can be updated via sync
              isActive: true,
            },
          });
          debugLog('[DEBUG] [TX] Created location:', location.id);
        } else {
          debugLog('[DEBUG] [TX] Found existing location:', location.id);
        }

        // Yastás line items never create a Sale/SaleItem — write them to the
        // parallel ledger instead, same transaction, no FIFO involved.
        debugLog('[DEBUG] [TX] Processing', yastasLineItems.length, 'Yastás line items...');
        for (const item of yastasLineItems) {
          const wallet = await tx.yastasWallet.findUnique({
            where: { locationId: location.id },
          });
          if (!wallet) {
            throw new SaleValidationError(
              `No YastasWallet for location ${location.id} — run the opening-balance cutover first`,
              { locationId: location.id, employeeId: item.employeeId },
            );
          }
          const operation = await tx.yastasOperation.create({
            data: {
              employeeId: item.employeeId,
              locationId: location.id,
              squareId: squareId,
              squareLineUid: item.lineUid,
              direction: 'IN',
              faceAmount: item.faceAmount,
              occurredAt: createdAt,
            },
          });
          await tx.walletMovement.create({
            data: {
              walletId: wallet.id,
              type: 'OPERATION_DEBIT',
              amount: item.faceAmount.neg(),
              relatedOperationId: operation.id,
            },
          });
          await tx.yastasWallet.update({
            where: { id: wallet.id },
            data: { balance: { decrement: item.faceAmount } },
          });
          debugLog(`[DEBUG] [TX] ✓ YastasOperation ${operation.id} + WalletMovement recorded`);
        }

        if (lineItems.length === 0 && customLines.length === 0) {
          // Pure-Yastás order — no Sale/SaleItem rows at all.
          return { saleId: null, itemCount: 0 };
        }

        debugLog('[DEBUG] [TX] Creating Sale record...');
        // Create Sale record (initial with temporary totals)
        const sale = await tx.sale.create({
          data: {
            squareId: squareId,
            locationId: location.id, // Use Location UUID, not Square location ID
            createdAt: createdAt,
            totalRevenue: new Prisma.Decimal(0), // Temporary
            totalCost: new Prisma.Decimal(0), // Temporary
            grossProfit: new Prisma.Decimal(0), // Temporary
          },
        });
        debugLog('[DEBUG] [TX] ✓ Sale record created:', sale.id);

        const saleItems: SaleItemOutput[] = [];

        // Process each line item
        debugLog('[DEBUG] [TX] Processing', lineItems.length, 'line items...');
        for (let i = 0; i < lineItems.length; i++) {
          const lineItem = lineItems[i];
          debugLog(`[DEBUG] [TX] Processing line item ${i + 1}/${lineItems.length}:`, {
            productId: lineItem.productId,
            quantitySold: lineItem.quantitySold,
            salePrice: lineItem.salePrice.toString(),
          });
          try {
            debugLog(`[DEBUG] [TX] Calling processSaleItem for line item ${i + 1}...`);
            const saleItem = await processSaleItem(
              sale.id,
              lineItem.productId,
              location.id, // Use Location UUID, not Square location ID
              lineItem.quantitySold,
              new Prisma.Decimal(lineItem.salePrice),
              squareId,
              tx,
            );
            debugLog(`[DEBUG] [TX] ✓ Line item ${i + 1} processed:`, {
              productId: saleItem.productId,
              quantity: saleItem.quantity,
              cost: saleItem.cost.toString(),
            });

            saleItems.push(saleItem);
          } catch (error) {
            // Log error with full context
            console.error(`[DEBUG] [TX] ERROR processing line item ${i + 1}:`, {
              error: error instanceof Error ? error.message : String(error),
              errorStack: error instanceof Error ? error.stack : undefined,
              productId: lineItem.productId,
              locationId: locationId,
              quantitySold: lineItem.quantitySold,
              saleId: sale.id,
            });

            // Re-throw to trigger transaction rollback
            throw error;
          }
        }

        if (customLines.length > 0) {
          await tx.unmatchedSaleLine.createMany({
            data: customLines.map((l) => ({ saleId: sale.id, squareLineUid: l.lineUid, description: l.description, quantity: l.quantity, amount: l.amount })),
          });
        }

        // Calculate sale totals
        debugLog('[DEBUG] [TX] Calculating sale totals...');
        const totals = calculateSaleTotals(saleItems, customLines);
        debugLog('[DEBUG] [TX] Sale totals:', {
          totalRevenue: totals.totalRevenue.toString(),
          totalCost: totals.totalCost.toString(),
          grossProfit: totals.grossProfit.toString(),
        });

        // Update Sale record with totals
        debugLog('[DEBUG] [TX] Updating Sale record with totals...');
        await tx.sale.update({
          where: { id: sale.id },
          data: {
            totalRevenue: totals.totalRevenue,
            totalCost: totals.totalCost,
            grossProfit: totals.grossProfit,
          },
        });
        debugLog('[DEBUG] [TX] ✓ Sale record updated');

        return { saleId: sale.id, itemCount: saleItems.length };
      },
      {
        timeout: 30000, // 30 second timeout
      },
    );

    saleId = result.saleId;
    itemCount = result.itemCount;

    // Phase 5: Success
    debugLog('[DEBUG] ========================================');
    debugLog('[DEBUG] ✓ Sale processed successfully!');
    debugLog('[DEBUG] Sale ID:', saleId);
    debugLog('[DEBUG] Square ID:', squareId);
    debugLog('[DEBUG] Location ID:', locationId);
    debugLog('[DEBUG] Item Count:', itemCount);
    debugLog('[DEBUG] ========================================');
  } catch (error) {
    // A setup problem found inside the transaction (e.g. no Yastás wallet) keeps its type.
    if (error instanceof SaleValidationError) {
      throw error;
    }

    if (error instanceof InsufficientInventoryError) {
      console.error('Insufficient inventory error:', {
        productId: error.productId,
        locationId: error.locationId,
        requested: error.requested,
        available: error.available,
        shortage: error.shortage,
        squareId: squareId,
      });
      // Transaction will rollback entire sale (Sale + SaleItems)
      // Optionally: could create Sale with status=PENDING_REVIEW here
      throw error;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      console.error('Database error:', {
        error: error.message,
        code: error.code,
        squareId: squareId,
      });
      throw new DatabaseTransactionError(error.message, error);
    }

    if (error instanceof DatabaseTransactionError) {
      throw error;
    }

    // Unknown error
    console.error('Unknown error processing sale:', {
      error,
      squareId: squareId,
    });
    throw new DatabaseTransactionError(
      `Unknown error: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}
/**
 * Matches a custom-amount line to a product: takes its stock and cost the way the
 * sale would have (FIFO, shortfall cover) and adds the cost to the sale. Revenue
 * is unchanged — it was counted when the sale arrived. Matching twice is a no-op.
 */
export async function processMatchJob(job: Job<{ lineId: string; productId: string; matchedBy: string }>): Promise<void> {
  const { lineId, productId, matchedBy } = job.data;
  await getPrisma().$transaction(async (tx) => {
    const line = await tx.unmatchedSaleLine.findUniqueOrThrow({ where: { id: lineId }, include: { sale: true } });
    if (line.matchedSaleItemId) return;

    const item = await processSaleItem(
      line.saleId,
      productId,
      line.sale.locationId,
      line.quantity,
      line.amount.div(line.quantity),
      line.sale.squareId,
      tx,
    );
    // Conditional, so two jobs racing on one line can't both match it.
    const { count } = await tx.unmatchedSaleLine.updateMany({
      where: { id: lineId, matchedSaleItemId: null },
      data: { matchedSaleItemId: item.id, matchedAt: new Date(), matchedBy },
    });
    if (count === 0) throw new DatabaseTransactionError(`Sale line ${lineId} was matched by another job`);

    await tx.sale.update({
      where: { id: line.saleId },
      data: { totalCost: { increment: item.cost }, grossProfit: { decrement: item.cost } },
    });
  });
}
