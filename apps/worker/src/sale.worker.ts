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
import { toSaleLines, type OrderLine } from './sale-lines';
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

  // A batch can't go negative: the Inventory_quantity_nonnegative CHECK
  // rejects this UPDATE, and with it the sale's transaction.
  await client.$executeRaw(
    Prisma.sql`
      UPDATE "Inventory" AS inv
      SET quantity = inv.quantity - v.qty
      FROM (VALUES ${rows}) AS v(id, qty)
      WHERE inv.id = v.id
    `,
  );
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
  squareLineUid: string | null,
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
      squareLineUid,
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

  // An exchange where the customer pays the difference: the order also lists what came back.
  await recordSquareReturns(returnLines(order), 'Cambio en Square');
  await recordOrderSale(order, { orderId, squareId, locationId, createdAt });
}

/** What a Square order took back: its `returns`' lines, each pointing at the sold line. */
type ReturnLine = {
  uid?: string | null;
  sourceLineItemUid?: string | null;
  quantity?: string | null;
  totalMoney?: { amount?: bigint | number | null } | null;
};
type SquareOrder = { lineItems?: OrderLine[] | null; returns?: Array<{ returnLineItems?: ReturnLine[] | null }> | null };

const returnLines = (order: SquareOrder) => (order.returns ?? []).flatMap((r) => r.returnLineItems ?? []);

/** Records an order's line items as a sale: FIFO stock and cost, Yastás lines and custom amounts. */
async function recordOrderSale(
  order: SquareOrder,
  { orderId, squareId, locationId, createdAt }: { orderId: string; squareId: string; locationId: string; createdAt: Date },
): Promise<void> {
  const orderLineItems = order.lineItems || [];

  if (orderLineItems.length === 0) {
    if (returnLines(order).length > 0) return; // only took items back
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
              lineItem.lineUid,
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
      null, // a return finds it through the matched line
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

export type ReturnJobData = {
  saleId: string;
  items: Array<{ saleItemId: string; quantity: number }>;
  reason?: string;
  returnedBy: string;
  clientRequestId: string;
};

/**
 * Records a customer return: each item goes back to stock as a RETURN batch at
 * its sold unit cost, and the sale's revenue, cost and profit drop by what came
 * back. Then Square's count goes up too. A resent request records nothing twice.
 */
export async function processReturnJob(job: Job<ReturnJobData>): Promise<void> {
  await recordReturn(job.data);
  await syncReturnToSquare(job.data.clientRequestId);
}

/**
 * A return as recordReturn takes it. `squareRestocked`: Square already put the
 * units back (a return made in Square). `amountOnly`: money back with no stock
 * (a custom amount, or a refund of an amount); `items` is then empty.
 */
type ReturnInput = Omit<ReturnJobData, 'returnedBy'> & { returnedBy?: string; squareRestocked?: boolean; amountOnly?: Prisma.Decimal };

async function recordReturn({ saleId, items, reason, returnedBy, clientRequestId, squareRestocked, amountOnly }: ReturnInput): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    // Jobs run concurrently: lock the sale first, so two returns (or a resent one) can't both pass the checks.
    await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;
    if (await tx.saleReturn.findUnique({ where: { clientRequestId } })) return;
    const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: { items: { include: { returns: true } } } });

    let revenue = amountOnly ?? new Prisma.Decimal(0);
    let cost = new Prisma.Decimal(0);
    const returned = [];
    for (const { saleItemId, quantity } of items) {
      const item = sale.items.find((i) => i.id === saleItemId);
      const alreadyReturned = item?.returns.reduce((n, r) => n + r.quantity, 0) ?? 0;
      if (!item || !(quantity > 0) || alreadyReturned + quantity > item.quantity) {
        throw new SaleValidationError('Return exceeds what is left of the sale item', { saleId, saleItemId, quantity, alreadyReturned });
      }
      const unitCost = item.cost.div(item.quantity);
      const batch = await tx.inventory.create({
        data: { productId: item.productId, locationId: sale.locationId, quantity, unitCost, receivedAt: new Date(), source: 'ADJUSTMENT' },
      });
      const adjustment = await tx.inventoryAdjustment.create({
        data: {
          locationId: sale.locationId,
          productId: item.productId,
          type: 'RETURN',
          quantity,
          unitCost,
          totalCost: unitCost.mul(quantity),
          createdBatchId: batch.id,
          reason: reason ?? 'Customer return',
          notes: `saleId=${saleId}`,
          adjustedBy: returnedBy,
          ...(squareRestocked && { squareSynced: true, squareSyncedAt: new Date() }),
        },
      });
      const itemRevenue = item.price.mul(quantity);
      const itemCost = unitCost.mul(quantity);
      revenue = revenue.add(itemRevenue);
      cost = cost.add(itemCost);
      returned.push({ saleItemId, adjustmentId: adjustment.id, quantity, revenue: itemRevenue, cost: itemCost });
    }

    await tx.saleReturn.create({ data: { saleId, clientRequestId, reason, returnedBy, revenue, cost, items: { create: returned } } });
    await tx.sale.update({
      where: { id: saleId },
      data: { totalRevenue: { decrement: revenue }, totalCost: { decrement: cost }, grossProfit: { decrement: revenue.sub(cost) } },
    });
  });
}

/**
 * Takes back what a Square order returned, against the sale each line was sold
 * on. Square restocked the units itself, so nothing is sent back to it. A line
 * sold before sales were recorded has no sale to take it from and is skipped.
 */
async function recordSquareReturns(lines: ReturnLine[], reason: string): Promise<void> {
  const prisma = getPrisma();
  for (const line of lines) {
    const source = line.sourceLineItemUid;
    if (!line.uid) {
      console.warn(`[SALE_WORKER] Square return line for ${source} has no uid to record it once by; nothing taken back`);
      continue;
    }
    const clientRequestId = `square-return-line:${line.uid}`;
    const quantity = line.quantity ? parseInt(line.quantity, 10) : 1;
    // A custom amount matched later took its stock through its matched sale item.
    const item = source
      ? await prisma.saleItem.findFirst({
          where: { OR: [{ squareLineUid: source }, { matchedFrom: { is: { squareLineUid: source } } }] },
          include: { returns: { select: { quantity: true } } },
        })
      : null;
    if (item) {
      // Square already gave the money back, so take back what is left instead of failing the rest of the refund
      // (e.g. the owner returned it by hand first).
      const left = item.quantity - item.returns.reduce((n, r) => n + r.quantity, 0);
      if (left < quantity) console.warn(`[SALE_WORKER] Square return line ${line.uid}: ${quantity} back but ${left} left on sale item ${item.id}`);
      if (left > 0) {
        const items = [{ saleItemId: item.id, quantity: Math.min(quantity, left) }];
        await recordReturn({ saleId: item.saleId, items, reason, clientRequestId, squareRestocked: true });
      }
      continue;
    }
    const custom = source ? await prisma.unmatchedSaleLine.findFirst({ where: { squareLineUid: source } }) : null;
    if (custom) {
      await recordReturn({ saleId: custom.saleId, items: [], reason, clientRequestId, amountOnly: centavos(line.totalMoney?.amount) });
      continue;
    }
    console.warn(`[SALE_WORKER] Square return line ${line.uid} has no recorded sale line (${source}); nothing taken back`);
  }
}

const centavos = (amount: bigint | number | null | undefined) => new Prisma.Decimal(String(amount ?? 0)).div(100);

/** A Square refund webhook event's refund (snake_case, as Square sends it). */
type SquareRefund = {
  id: string;
  status: string;
  order_id?: string;
  payment_id?: string;
  location_id: string;
  reason?: string;
  amount_money?: { amount?: number };
  created_at?: string;
};

/**
 * A refund made in Square: takes back what its order returned and records what
 * the customer took instead (an exchange) as a sale keyed on the refund. A
 * refund with nothing returned takes its amount off the paid sale. Each part is
 * recorded once, so refund.created and refund.updated can both arrive.
 */
export async function processRefundJob(job: Job): Promise<void> {
  const refund: SquareRefund | undefined = job.data?.payload?.object?.refund;
  if (!refund?.id || !refund.order_id) {
    throw new SaleValidationError('Refund event missing refund id or order_id', { jobId: job.id });
  }
  if (refund.status !== 'COMPLETED') return;

  const { order } = await getSquareClient().orders.get({ orderId: refund.order_id });
  if (!order) throw new SaleValidationError(`Order ${refund.order_id} not found in Square`, { refundId: refund.id });

  const reason = refund.reason?.trim() || 'Reembolso en Square';
  const lines = returnLines(order);
  await recordSquareReturns(lines, reason);

  if (lines.length === 0) {
    const sale = refund.payment_id ? await getPrisma().sale.findUnique({ where: { squareId: refund.payment_id } }) : null;
    if (!sale) {
      console.warn(`[SALE_WORKER] Refund ${refund.id} is for payment ${refund.payment_id}, which has no recorded sale; nothing taken back`);
    } else {
      await recordReturn({ saleId: sale.id, items: [], reason, clientRequestId: `square-refund:${refund.id}`, amountOnly: centavos(refund.amount_money?.amount) });
    }
  }

  if (order.lineItems?.length && !(await getPrisma().sale.findUnique({ where: { squareId: refund.id } }))) {
    await recordOrderSale(order, {
      orderId: refund.order_id,
      squareId: refund.id,
      locationId: refund.location_id,
      createdAt: refund.created_at ? new Date(refund.created_at) : new Date(),
    });
  }
}

/**
 * Puts a return's units back in Square's stock, like the api does for
 * adjustments (inventory-adjustment.service.ts syncToSquare). Keyed on the
 * adjustment, so a retry never doubles them. A Square failure fails the job so
 * BullMQ retries it; a product or location Square doesn't know is recorded instead.
 */
async function syncReturnToSquare(clientRequestId: string): Promise<void> {
  const prisma = getPrisma();
  const saleReturn = await prisma.saleReturn.findUniqueOrThrow({
    where: { clientRequestId },
    include: { items: { include: { adjustment: { include: { location: { select: { squareId: true } } } } } } },
  });

  for (const { adjustment } of saleReturn.items) {
    if (adjustment.squareSynced) continue;
    const mapping = await prisma.catalogMapping.findFirst({ where: { productId: adjustment.productId }, select: { squareVariationId: true } });
    const record = (squareSyncError: string | null) =>
      prisma.inventoryAdjustment.update({
        where: { id: adjustment.id },
        data: { squareSynced: !squareSyncError, squareSyncedAt: squareSyncError ? null : new Date(), squareSyncError },
      });
    if (!adjustment.location.squareId || !mapping) {
      await record(!mapping ? 'Product not mapped to Square catalog' : 'Location not linked to Square');
      continue;
    }

    try {
      const response = await getSquareClient().inventory.batchCreateChanges({
        idempotencyKey: adjustment.id,
        changes: [
          {
            type: 'ADJUSTMENT',
            adjustment: {
              catalogObjectId: mapping.squareVariationId,
              locationId: adjustment.location.squareId,
              quantity: adjustment.quantity.toString(),
              fromState: 'UNLINKED_RETURN',
              toState: 'IN_STOCK',
              occurredAt: adjustment.adjustedAt.toISOString(),
              referenceId: `adjustment-RETURN-${adjustment.id}`,
            },
          },
        ],
      });
      if (response.errors?.length) throw new Error(response.errors.map((e) => e.detail || e.code).join('; '));
      await record(null);
    } catch (error) {
      await record(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
