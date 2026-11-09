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
import { findSquareVariationId, mapVariationToProduct, type MappedProduct } from './catalog.mapper';
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
  coverWhy?: string,
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
          // The api lists labeled covers by this exact text (BreakBulkService.automaticOpenings).
          notes: coverWhy ? `squareId=${squareId} · caja no abierta: ${coverWhy}` : `squareId=${squareId}`,
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
  coverWhy?: string,
): Promise<SaleItemOutput> {
  // Step 1: Calculate FIFO cost (this queries inventory)
  const costResult = await calculateFIFOCost(productId, locationId, quantitySold, squareId, client, coverWhy);

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

/** Links a sale item to the batches it took from, each at its own cost (the FIFO audit trail). */
async function recordInventoryConsumption(
  saleItemId: string,
  consumedBatches: ConsumedBatch[],
  client: Prisma.TransactionClient,
): Promise<void> {
  if (consumedBatches.length === 0) return;
  await client.inventoryConsumption.createMany({
    data: consumedBatches.map((batch) => ({
      inventoryId: batch.batchId,
      saleItemId,
      quantity: batch.quantityConsumed,
      unitCost: batch.unitCost,
      totalCost: batch.costContribution,
    })),
  });
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

/** A Square payment.created event: records its order as a sale with FIFO cost, once per payment. */
export async function processSaleJob(job: Job): Promise<void> {
  // The webhook (and the dev test-sale tool) queue Square's event.data, so the payment is at payload.object.payment.
  // Errors name the payment by id only: the payment holds card details and the buyer's email (failed-job.ts).
  const payload = job.data?.payload;
  const payment = payload?.object?.payment;
  if (!payment || typeof payment !== 'object') {
    throw new SaleValidationError('Missing payment object in payload', { jobId: job.id });
  }
  const { id: squareId, location_id: locationId, order_id: orderId } = payment;
  if (!squareId) throw new SaleValidationError('Payment object missing id', { jobId: job.id });
  if (!locationId) throw new SaleValidationError('Payment object missing location_id', { paymentId: squareId });
  const createdAt = payment.created_at ? new Date(payment.created_at) : new Date();

  // ponytail: one sale per payment, whole order each time — right only while orders
  // are paid in one cash payment. Split payments need once-per-order_id and a
  // COMPLETED-status check (vision.md, Key Constraints).
  if (await getPrisma().sale.findUnique({ where: { squareId } })) return;
  // A purely-Yastás order never creates a Sale row, so the check above can't
  // catch a redelivered webhook for it — check YastasOperation too.
  if (await getPrisma().yastasOperation.findFirst({ where: { squareId } })) return;

  if (!orderId) throw new SaleValidationError('Payment object missing order_id', { paymentId: squareId });
  // A dev test sale (sales-test.service.ts) carries its order instead of having it fetched from Square.
  const order = payload._testOrderData ?? (await fetchOrder(orderId, squareId));

  // An exchange where the customer pays the difference: the order also lists what came back.
  await recordSquareReturns(returnLines(order), 'Cambio en Square');
  const lastTry = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
  await recordOrderSale(order, { orderId, squareId, locationId, createdAt, lastTry });
}

async function fetchOrder(orderId: string, squareId: string) {
  let order;
  try {
    ({ order } = await getSquareClient().orders.get({ orderId }));
  } catch (error) {
    throw new SaleValidationError(`Failed to fetch order from Square: ${error instanceof Error ? error.message : String(error)}`, { orderId, squareId });
  }
  if (!order) throw new SaleValidationError(`Order ${orderId} not found in Square`, { orderId, squareId });
  return order;
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

/**
 * Opens linked boxes, through the api's "Abrir caja" code, for each suelto the
 * sale needs more of than the store has. Returns, per product, why a shortfall
 * the sale still has will be covered without a box (the cover's label).
 *
 * A failed call fails the job while tries remain. On the last try the sale is
 * recorded anyway, with today's cover, unless the api opened the box and only
 * its reply was lost (found by the opening's key).
 */
async function openBoxesForSale(
  lines: Array<{ productId: string; quantitySold: number }>,
  { squareId, squareLocationId, createdAt, lastTry }: { squareId: string; squareLocationId: string; createdAt: Date; lastTry: boolean },
): Promise<Map<string, string>> {
  const why = new Map<string, string>();
  const prisma = getPrisma();
  // Only where the sale will be recorded: the transaction refuses or skips the rest.
  const location = await prisma.location.findUnique({ where: { squareId: squareLocationId } });
  const cutover = location && (await storeCutover(prisma, location.id));
  if (!location || !cutover || createdAt <= cutover.cutoverDate) return why;

  const needed = new Map<string, number>();
  for (const { productId, quantitySold } of lines) needed.set(productId, (needed.get(productId) ?? 0) + quantitySold);

  // One product at a time, up to 10s each: fine for the job lock, which BullMQ renews
  // while the job awaits (lockDuration / 2), so a slow api never makes it stall.
  for (const [productId, pieces] of needed) {
    if (!(await prisma.productLooseLink.count({ where: { looseProductId: productId, locationId: location.id } }))) continue; // not a suelto here
    const { _sum } = await prisma.inventory.aggregate({ where: { productId, locationId: location.id, quantity: { gt: 0 } }, _sum: { quantity: true } });
    if ((_sum.quantity ?? 0) >= pieces) continue;

    const requestKey = `${squareId}:${productId}`;
    try {
      const { boxesOpened } = await coverLoose({ locationId: location.id, looseProductId: productId, needed: pieces, requestKey });
      why.set(productId, boxesOpened ? 'cajas insuficientes' : 'sin caja con existencias');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Opened, but the reply was lost. The usual cause: the api tells Square before it
      // answers, and a slow Square outlasts the timeout. Without this the sale would retry
      // and warn of an outage for nothing (the transaction still covers only real shortfalls).
      if (await prisma.inventoryAdjustment.findUnique({ where: { clientRequestId: `auto-open:${requestKey}:in` } })) continue;
      if (!lastTry) throw new Error(`Box opening for payment ${squareId} failed, retrying: ${reason}`);
      console.warn(`[SALE_WORKER] Payment ${squareId}: no box opened for product ${productId} (${reason}); covering without one`);
      why.set(productId, 'api no disponible');
    }
  }
  return why;
}

/** The api's cover-loose route (BreakBulkService.coverLoose), over Railway's private network. */
async function coverLoose(body: { locationId: string; looseProductId: string; needed: number; requestKey: string }): Promise<{ boxesOpened: number }> {
  const url = process.env.API_INTERNAL_URL;
  const secret = process.env.WORKER_API_SECRET;
  if (!url || !secret) throw new Error('API_INTERNAL_URL or WORKER_API_SECRET is not set');
  const response = await fetch(`${url}/internal/inventory/cover-loose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-secret': secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`api answered ${response.status}`);
  return ((await response.json()) as { data: { boxesOpened: number } }).data;
}

/** The store's latest cutover, or the one covering every store. */
function storeCutover(client: Prisma.TransactionClient | PrismaClient, locationId: string) {
  return client.cutoverLock.findFirst({
    where: { OR: [{ locationId }, { locationId: null }], isLocked: true },
    orderBy: { cutoverDate: 'desc' },
  });
}

/**
 * Records an order's line items as a sale: FIFO stock and cost, Yastás lines and custom amounts.
 * A failure rolls the whole order back; the worker manager logs it (failed-job.ts).
 */
async function recordOrderSale(
  order: SquareOrder,
  { orderId, squareId, locationId, createdAt, lastTry = true }: { orderId: string; squareId: string; locationId: string; createdAt: Date; lastTry?: boolean },
): Promise<void> {
  const orderLineItems = order.lineItems || [];
  if (orderLineItems.length === 0) {
    if (returnLines(order).length > 0) return; // only took items back
    throw new SaleValidationError('Order has no line items', { orderId, squareId, locationId });
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

  const { saleItems: lineItems, yastasLines, customLines } = toSaleLines(orderLineItems, mappings, { orderId, squareId, locationId });
  // Before the transaction: no HTTP call while it holds locks.
  const coverWhy = await openBoxesForSale(lineItems, { squareId, squareLocationId: locationId, createdAt, lastTry });

  try {
    await getPrisma().$transaction(
      async (tx) => {
        // Sales are recorded only after the store's cutover. A refused sale fails
        // the job, which is kept for replay once the store is cut over.
        const location = await tx.location.findUnique({ where: { squareId: locationId } });
        if (!location) {
          throw new SaleValidationError(`Square location ${locationId} is not linked to a store`, { locationId, squareId });
        }
        const cutover = await storeCutover(tx, location.id);
        if (!cutover) {
          throw new SaleValidationError(`${location.name} has not finished its cutover; replay this sale once it has`, { locationId, squareId });
        }
        // Sold before the opening count, so the count already left it off the shelf.
        if (createdAt <= cutover.cutoverDate) {
          console.warn(`[SALE_WORKER] Payment ${squareId} at ${location.name} predates its cutover; nothing recorded`);
          return;
        }

        // Yastás lines never create a Sale/SaleItem — they go to the parallel ledger, no FIFO.
        for (const item of yastasLines) {
          const wallet = await tx.yastasWallet.findUnique({ where: { locationId: location.id } });
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
              squareId,
              squareLineUid: item.lineUid,
              direction: 'IN',
              faceAmount: item.faceAmount,
              occurredAt: createdAt,
            },
          });
          await tx.walletMovement.create({
            data: { walletId: wallet.id, type: 'OPERATION_DEBIT', amount: item.faceAmount.neg(), relatedOperationId: operation.id },
          });
          await tx.yastasWallet.update({ where: { id: wallet.id }, data: { balance: { decrement: item.faceAmount } } });
        }

        if (lineItems.length === 0 && customLines.length === 0) return; // only Yastás lines

        // Totals are set once the items' FIFO costs are known.
        const sale = await tx.sale.create({
          data: {
            squareId,
            locationId: location.id,
            createdAt,
            totalRevenue: new Prisma.Decimal(0),
            totalCost: new Prisma.Decimal(0),
            grossProfit: new Prisma.Decimal(0),
          },
        });

        const saleItems: SaleItemOutput[] = [];
        for (const lineItem of lineItems) {
          saleItems.push(await processSaleItem(
            sale.id,
            lineItem.productId,
            location.id,
            lineItem.quantitySold,
            new Prisma.Decimal(lineItem.salePrice),
            squareId,
            lineItem.lineUid,
            tx,
            coverWhy.get(lineItem.productId),
          ));
        }

        if (customLines.length > 0) {
          await tx.unmatchedSaleLine.createMany({
            data: customLines.map((l) => ({ saleId: sale.id, squareLineUid: l.lineUid, description: l.description, quantity: l.quantity, amount: l.amount })),
          });
        }

        await tx.sale.update({ where: { id: sale.id }, data: calculateSaleTotals(saleItems, customLines) });
      },
      { timeout: 30000 },
    );
  } catch (error) {
    // A refusal (e.g. no Yastás wallet) and a stock shortfall keep their type.
    if (error instanceof SaleValidationError || error instanceof InsufficientInventoryError || error instanceof DatabaseTransactionError) {
      throw error;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new DatabaseTransactionError(`${error.code}: ${error.message}`, error);
    }
    throw new DatabaseTransactionError(`Unknown error: ${error instanceof Error ? error.message : String(error)}`, error);
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
 * Records a customer return made by hand: each item goes back to stock as a
 * RETURN batch at its sold unit cost, and the return keeps what it gave back
 * (reports count it on the day it happened). Then Square's count goes up too.
 * A resent request records nothing twice.
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
    const sale = await tx.sale.findUniqueOrThrow({
      where: { id: saleId },
      include: { items: { include: { returns: true, product: { select: { name: true } } } } },
    });

    // One request can list an item twice: check what it takes back in total.
    const requested = new Map<string, number>();
    for (const { saleItemId, quantity } of items) requested.set(saleItemId, (requested.get(saleItemId) ?? 0) + quantity);

    let revenue = amountOnly ?? new Prisma.Decimal(0);
    let cost = new Prisma.Decimal(0);
    const returned = [];
    for (const [saleItemId, quantity] of requested) {
      const item = sale.items.find((i) => i.id === saleItemId);
      const left = item ? item.quantity - item.returns.reduce((n, r) => n + r.quantity, 0) : 0;
      if (!item || !(quantity > 0) || quantity > left) {
        throw new SaleValidationError(`Solo quedan ${left} de ${item?.product.name ?? 'ese artículo'} por devolver`, { saleId, saleItemId, quantity });
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

    // A return counts in its own month, so the sale keeps its totals as sold.
    // Square paid its own refunds back; one made by hand was paid in cash.
    const cashRefunded = squareRestocked || amountOnly ? null : revenue;
    await tx.saleReturn.create({ data: { saleId, clientRequestId, reason, returnedBy, revenue, cost, cashRefunded, items: { create: returned } } });
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
    const catalogObjectId = await findSquareVariationId(prisma, adjustment.productId, adjustment.locationId);
    const record = (squareSyncError: string | null) =>
      prisma.inventoryAdjustment.update({
        where: { id: adjustment.id },
        data: { squareSynced: !squareSyncError, squareSyncedAt: squareSyncError ? null : new Date(), squareSyncError },
      });
    if (!adjustment.location.squareId || !catalogObjectId) {
      await record(!catalogObjectId ? 'Product not mapped to Square catalog' : 'Location not linked to Square');
      continue;
    }

    try {
      const response = await getSquareClient().inventory.batchCreateChanges({
        idempotencyKey: adjustment.id,
        changes: [
          {
            type: 'ADJUSTMENT',
            adjustment: {
              catalogObjectId,
              fromLocationId: adjustment.location.squareId,
              toLocationId: adjustment.location.squareId,
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
