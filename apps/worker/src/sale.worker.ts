import { Job } from 'bullmq';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { SquareClient, SquareEnvironment } from 'square';
import {
  InsufficientInventoryError,
  DatabaseTransactionError,
  SaleValidationError,
} from './errors';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Initialize Square client
const squareAccessToken = process.env.SQUARE_ACCESS_TOKEN;
if (!squareAccessToken) {
  throw new Error('SQUARE_ACCESS_TOKEN environment variable is not set');
}

const squareEnvironment =
  (process.env.SQUARE_ENVIRONMENT as SquareEnvironment) ||
  SquareEnvironment.Production;

const squareClient = new SquareClient({
  token: squareAccessToken,
  environment: squareEnvironment,
});

// ============================================================================
// Type Definitions
// ============================================================================

interface ConsumedBatch {
  batchId: string;
  quantityConsumed: number;
  costContribution: Prisma.Decimal;
}

interface FIFOCostResult {
  totalCost: Prisma.Decimal;
  consumedBatches: ConsumedBatch[];
  remainingQuantity: number;
}

interface SaleItemInput {
  productId: string;
  quantitySold: number;
  salePrice: Prisma.Decimal | string | number;
}

interface SaleItemOutput {
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
 * Calculate FIFO cost for a sale item by consuming inventory batches in chronological order
 * FIFO ordering is mandatory: always order by receivedAt ASC, never by createdAt
 */
async function calculateFIFOCost(
  productId: string,
  locationId: string,
  quantitySold: number,
  tx?: Omit<
    PrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
  >,
): Promise<FIFOCostResult> {
  const client = tx || prisma;

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

  // Step 2: Initialize accumulator
  let remainingQty = quantitySold;
  let totalCost = new Prisma.Decimal(0);
  const consumedBatches: ConsumedBatch[] = [];

  // Step 3: Consume batches sequentially
  for (const batch of batches) {
    if (remainingQty <= 0) {
      break;
    }

    const qtyToConsume = Math.min(batch.quantity, remainingQty);
    const costContribution = new Prisma.Decimal(batch.unitCost).mul(qtyToConsume);

    totalCost = totalCost.add(costContribution);

    consumedBatches.push({
      batchId: batch.id,
      quantityConsumed: qtyToConsume,
      costContribution: costContribution,
    });

    remainingQty -= qtyToConsume;
  }

  // Step 4: Validate sufficient inventory
  if (remainingQty > 0) {
    const available = quantitySold - remainingQty;
    throw new InsufficientInventoryError(
      productId,
      locationId,
      quantitySold,
      available,
      remainingQty,
    );
  }

  return {
    totalCost: totalCost,
    consumedBatches: consumedBatches,
    remainingQuantity: 0,
  };
}

/**
 * Atomically decrement inventory batches consumed in FIFO cost calculation
 */
async function deductInventory(
  consumedBatches: ConsumedBatch[],
  tx?: Omit<
    PrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
  >,
): Promise<void> {
  const client = tx || prisma;

  for (const consumedBatch of consumedBatches) {
    const updated = await client.inventory.update({
      where: { id: consumedBatch.batchId },
      data: {
        quantity: {
          decrement: consumedBatch.quantityConsumed,
        },
      },
    });

    // Validate quantity doesn't go negative (database constraint should enforce)
    if (updated.quantity < 0) {
      throw new DatabaseTransactionError(
        `Inventory quantity went negative for batch ${consumedBatch.batchId}. ` +
          `Quantity after update: ${updated.quantity}`,
      );
    }
  }
}

/**
 * Process a single sale item: calculate FIFO cost, deduct inventory, create SaleItem record
 * All operations must be in a transaction (handled by caller)
 */
async function processSaleItem(
  saleId: string,
  productId: string,
  locationId: string,
  quantitySold: number,
  salePrice: Prisma.Decimal | string | number,
  tx?: Omit<
    PrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
  >,
): Promise<SaleItemOutput> {
  const client = tx || prisma;

  // Step 1: Calculate FIFO cost (this queries inventory)
  const costResult = await calculateFIFOCost(
    productId,
    locationId,
    quantitySold,
    tx,
  );

  // Step 2: Deduct inventory (atomic update)
  await deductInventory(costResult.consumedBatches, tx);

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

  return {
    saleId: saleItem.saleId,
    productId: saleItem.productId,
    quantity: saleItem.quantity,
    price: saleItem.price,
    cost: saleItem.cost,
  };
}

/**
 * Calculate total revenue, total cost, and gross profit for a sale
 */
function calculateSaleTotals(saleItems: SaleItemOutput[]): SaleTotals {
  let totalRevenue = new Prisma.Decimal(0);
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
  const { payload } = job.data;
  console.log('Processing sale job:', job.id);

  // Phase 1: Validation & Idempotency
  // Extract payment from job.data.payload.object
  const payment = payload?.object;

  if (!payment) {
    throw new SaleValidationError(
      'Missing payment object in payload',
      { payload: JSON.stringify(payload) },
    );
  }

  if (!payment.id) {
    throw new SaleValidationError(
      'Payment object missing id',
      { payment: JSON.stringify(payment) },
    );
  }

  if (!payment.location_id) {
    throw new SaleValidationError(
      'Payment object missing location_id',
      { payment: JSON.stringify(payment) },
    );
  }

  const squareId = payment.id;
  const locationId = payment.location_id;
  const orderId = payment.order_id;
  const createdAt = payment.created_at
    ? new Date(payment.created_at)
    : new Date();

  console.log('Processing payment:', { squareId, locationId, orderId });

  // Check if sale with squareId already exists (idempotency)
  const existing = await prisma.sale.findUnique({
    where: { squareId },
  });
  if (existing) {
    console.log(`Sale ${squareId} already exists, skipping (idempotent)`);
    return;
  }

  // Phase 2: Fetch Order Data from Square
  if (!orderId) {
    throw new SaleValidationError(
      'Payment object missing order_id',
      { payment: JSON.stringify(payment) },
    );
  }

  let order;
  try {
    const response = await squareClient.orders.get({
      orderId: orderId,
    });
    order = response.order;

    if (!order) {
      throw new SaleValidationError(
        `Order ${orderId} not found in Square`,
        { orderId, squareId },
      );
    }
  } catch (error) {
    console.error('Error fetching order from Square:', {
      error,
      orderId,
      squareId,
    });
    throw new SaleValidationError(
      `Failed to fetch order from Square: ${error instanceof Error ? error.message : String(error)}`,
      { orderId, squareId },
    );
  }

  // Extract line items from order
  const orderLineItems = order.lineItems || [];

  if (!orderLineItems || orderLineItems.length === 0) {
    throw new SaleValidationError(
      'Order has no line items',
      { orderId, squareId, locationId },
    );
  }

  // Map Square line items to SaleItemInput
  // Note: This assumes products are mapped by SKU or variation ID
  // You may need to adjust the mapping logic based on your product setup
  const lineItems: SaleItemInput[] = [];

  for (const orderLineItem of orderLineItems) {
    if (!orderLineItem.uid && !orderLineItem.catalogObjectId) {
      console.warn('Skipping line item without uid or catalogObjectId:', orderLineItem);
      continue;
    }

    // Try to find product by catalogObjectId (variation ID) or SKU
    const catalogObjectId = orderLineItem.catalogObjectId;
    const itemName = orderLineItem.name;

    // Find product by SKU (using name as fallback, or catalogObjectId if you have a mapping)
    // Note: You may need to create a mapping table for catalogObjectId -> productId
    let product;
    
    // First, try to find by SKU if the name matches a SKU pattern
    if (itemName) {
      product = await prisma.product.findUnique({
        where: { sku: itemName },
      });
    }

    // If not found by SKU, you could:
    // 1. Create a ProductMapping table with catalogObjectId -> productId
    // 2. Or fetch catalog item variation to get SKU
    // For now, we'll require products to have SKU matching the item name
    if (!product) {
      throw new SaleValidationError(
        `Product not found for line item. Name: ${itemName}, Catalog Object ID: ${catalogObjectId}. ` +
          `Please ensure product SKU matches the item name, or create a mapping for catalogObjectId.`,
        {
          orderLineItem: JSON.stringify(orderLineItem),
          orderId,
          squareId,
        },
      );
    }

    const quantity = orderLineItem.quantity
      ? parseInt(orderLineItem.quantity, 10)
      : 1;

    if (quantity <= 0) {
      throw new SaleValidationError(
        'Line item quantity must be positive',
        { orderLineItem: JSON.stringify(orderLineItem) },
      );
    }

    // Get price from line item
    // totalMoney is the total price for the quantity (in cents)
    // basePriceMoney would be the unit price, but we'll calculate from totalMoney
    const totalMoney = orderLineItem.totalMoney;
    if (!totalMoney || totalMoney.amount === undefined || totalMoney.amount === null) {
      throw new SaleValidationError(
        'Line item missing price information',
        { orderLineItem: JSON.stringify(orderLineItem) },
      );
    }

    // Convert from cents to dollars and calculate unit price
    // totalMoney.amount is a bigint, convert to string first
    const totalPriceInDollars = new Prisma.Decimal(totalMoney.amount.toString()).div(100);
    const unitPrice = totalPriceInDollars.div(quantity);

    lineItems.push({
      productId: product.id,
      quantitySold: quantity,
      salePrice: new Prisma.Decimal(unitPrice),
    });
  }

  if (lineItems.length === 0) {
    throw new SaleValidationError(
      'No valid line items found after mapping',
      { orderId, squareId, locationId },
    );
  }

  // Validate line items structure
  for (const item of lineItems) {
    if (!item.productId) {
      throw new SaleValidationError('Line item missing productId', { item });
    }
    if (!item.quantitySold || item.quantitySold <= 0) {
      throw new SaleValidationError(
        'Line item quantity must be positive',
        { item },
      );
    }
    if (!item.salePrice || new Prisma.Decimal(item.salePrice).lt(0)) {
      throw new SaleValidationError(
        'Line item salePrice must be non-negative',
        { item },
      );
    }
  }

  // Phase 3 & 4: Create Sale Record and Process Items (all in transaction)
  let saleId: string;
  let itemCount: number;

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        // Create Sale record (initial with temporary totals)
        const sale = await tx.sale.create({
          data: {
            squareId: squareId,
            locationId: locationId,
            createdAt: createdAt,
            totalRevenue: new Prisma.Decimal(0), // Temporary
            totalCost: new Prisma.Decimal(0), // Temporary
            grossProfit: new Prisma.Decimal(0), // Temporary
          },
        });

        const saleItems: SaleItemOutput[] = [];

        // Process each line item
        for (const lineItem of lineItems) {
          try {
            const saleItem = await processSaleItem(
              sale.id,
              lineItem.productId,
              locationId,
              lineItem.quantitySold,
              new Prisma.Decimal(lineItem.salePrice),
              tx,
            );

            saleItems.push(saleItem);
          } catch (error) {
            // Log error with full context
            console.error('Error processing sale item:', {
              error,
              productId: lineItem.productId,
              locationId: locationId,
              quantitySold: lineItem.quantitySold,
              saleId: sale.id,
            });

            // Re-throw to trigger transaction rollback
            throw error;
          }
        }

        // Calculate sale totals
        const totals = calculateSaleTotals(saleItems);

        // Update Sale record with totals
        await tx.sale.update({
          where: { id: sale.id },
          data: {
            totalRevenue: totals.totalRevenue,
            totalCost: totals.totalCost,
            grossProfit: totals.grossProfit,
          },
        });

        return { saleId: sale.id, itemCount: saleItems.length };
      },
      {
        timeout: 30000, // 30 second timeout
      },
    );

    saleId = result.saleId;
    itemCount = result.itemCount;

    // Phase 5: Success
    console.log('Sale processed successfully:', {
      saleId: saleId,
      squareId: squareId,
      locationId: locationId,
      itemCount: itemCount,
    });
  } catch (error) {
    // Error handling
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