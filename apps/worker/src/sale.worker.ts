import { Job } from 'bullmq';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { SquareClient, SquareEnvironment } from 'square';
import {
  InsufficientInventoryError,
  DatabaseTransactionError,
  SaleValidationError,
  UnmappedVariationError,
} from './errors';
import { mapVariationToProduct } from './catalog.mapper';

// Lazy initialization of database connection (env vars loaded by worker.ts first)
let pool: Pool | null = null;
let prisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!prisma) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    pool = new Pool({ connectionString });
    const adapter = new PrismaPg(pool);
    prisma = new PrismaClient({ adapter });
    console.log('[DEBUG] [SALE_WORKER] Prisma client initialized');
  }
  return prisma;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Safely stringify objects that may contain BigInt values
 * BigInt values are converted to strings
 */
function safeStringify(obj: any, space?: number): string {
  return JSON.stringify(
    obj,
    (key, value) => {
      if (typeof value === 'bigint') {
        return value.toString() + 'n'; // Add 'n' suffix to indicate it was a BigInt
      }
      return value;
    },
    space,
  );
}

// Lazy initialization of Square client (only when needed)
let squareClient: SquareClient | null = null;

function getSquareClient(): SquareClient {
  if (!squareClient) {
    console.log('[DEBUG] [SQUARE_CLIENT] Initializing Square client...');
    console.log('[DEBUG] [SQUARE_CLIENT] Checking for SQUARE_ACCESS_TOKEN...');
    console.log('[DEBUG] [SQUARE_CLIENT] SQUARE_ACCESS_TOKEN exists:', !!process.env.SQUARE_ACCESS_TOKEN);
    console.log('[DEBUG] [SQUARE_CLIENT] SQUARE_ACCESS_TOKEN length:', process.env.SQUARE_ACCESS_TOKEN?.length || 0);
    console.log('[DEBUG] [SQUARE_CLIENT] SQUARE_ENVIRONMENT:', process.env.SQUARE_ENVIRONMENT || 'not set (will use Production)');
    
    let squareAccessToken = process.env.SQUARE_ACCESS_TOKEN;
    
    // Trim whitespace in case there are spaces in the token value
    if (squareAccessToken) {
      squareAccessToken = squareAccessToken.trim();
      console.log('[DEBUG] [SQUARE_CLIENT] Token after trim length:', squareAccessToken.length);
      
      // Check for spaces in the token (common issue)
      if (squareAccessToken.includes(' ')) {
        console.warn('[DEBUG] [SQUARE_CLIENT] ⚠️ WARNING: Token contains spaces! This might cause issues.');
        console.warn('[DEBUG] [SQUARE_CLIENT] Token preview (first 10 chars):', squareAccessToken.substring(0, 10) + '...');
      }
    }
    
    if (!squareAccessToken) {
      console.error('[DEBUG] [SQUARE_CLIENT] ERROR: SQUARE_ACCESS_TOKEN is not set');
      console.error('[DEBUG] [SQUARE_CLIENT] All environment variables starting with SQUARE_:');
      const squareVars = Object.keys(process.env).filter(key => key.startsWith('SQUARE_'));
      if (squareVars.length === 0) {
        console.error('[DEBUG] [SQUARE_CLIENT]   No SQUARE_* variables found in process.env');
      } else {
        squareVars.forEach(key => {
          const value = process.env[key];
          console.error(`[DEBUG] [SQUARE_CLIENT]   ${key}: ${value ? '***' + value.slice(-4) + ` (length: ${value.length})` : 'not set'}`);
        });
      }
      throw new Error('SQUARE_ACCESS_TOKEN environment variable is not set');
    }

    // Determine Square environment: use Sandbox for staging/dev, Production otherwise
    let squareEnvironment: SquareEnvironment;
    const nodeEnv = process.env.NODE_ENV?.toLowerCase();
    const railwayEnv = process.env.RAILWAY_ENVIRONMENT?.toLowerCase();
    const squareEnv = process.env.SQUARE_ENVIRONMENT?.toLowerCase();

    if (
      squareEnv === 'sandbox' ||
      nodeEnv === 'development' ||
      nodeEnv === 'dev' ||
      railwayEnv === 'staging' ||
      railwayEnv === 'development'
    ) {
      squareEnvironment = SquareEnvironment.Sandbox;
    } else if (squareEnv === 'production') {
      squareEnvironment = SquareEnvironment.Production;
    } else {
      // Default to Production for safety
      squareEnvironment = SquareEnvironment.Production;
    }

    console.log('[DEBUG] [SQUARE_CLIENT] Creating Square client with environment:', squareEnvironment);
    console.log('[DEBUG] [SQUARE_CLIENT] NODE_ENV:', nodeEnv || 'not set');
    console.log('[DEBUG] [SQUARE_CLIENT] RAILWAY_ENVIRONMENT:', railwayEnv || 'not set');
    console.log('[DEBUG] [SQUARE_CLIENT] SQUARE_ENVIRONMENT:', squareEnv || 'not set');
    squareClient = new SquareClient({
      token: squareAccessToken,
      environment: squareEnvironment,
    });
    console.log('[DEBUG] [SQUARE_CLIENT] ✅ Square client initialized');
  }
  return squareClient;
}

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
  const client = tx || getPrisma();

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
  const client = tx || getPrisma();

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
 * 
 * FIFO AUDIT TRAIL: Records which inventory batches were consumed in InventoryConsumption table
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
  const client = tx || getPrisma();

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

  // Step 4: Record consumption in audit trail (FIFO traceability)
  // This creates an immutable record of which batches were consumed for this sale
  await recordInventoryConsumption(saleItem.id, costResult.consumedBatches, client);

  return {
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
  client: Omit<
    PrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
  >,
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
    
    console.log(
      `[FIFO_AUDIT] Recorded ${consumptionRecords.length} consumption records for saleItem ${saleItemId}`,
    );
  }
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
  console.log('[DEBUG] ========================================');
  console.log('[DEBUG] Starting processSaleJob');
  console.log('[DEBUG] Job ID:', job.id);
  console.log('[DEBUG] Job data:', JSON.stringify(job.data, null, 2));
  
  // Extract payload from job data
  if (!job.data) {
    console.error('[DEBUG] ERROR: job.data is missing');
    throw new SaleValidationError('Job data is missing', { jobId: job.id });
  }
  
  const { payload } = job.data;
  console.log('[DEBUG] Extracted payload:', JSON.stringify(payload, null, 2));

  if (!payload) {
    console.error('[DEBUG] ERROR: payload is missing from job.data');
    console.error('[DEBUG] Full job.data:', JSON.stringify(job.data, null, 2));
    throw new SaleValidationError(
      'Missing payload in job data',
      { jobData: JSON.stringify(job.data) },
    );
  }

  // Phase 1: Validation & Idempotency
  // Extract payment from job.data.payload.object
  // Note: Square webhook structure is: event.data.object.payment
  // But queue sends: payload = event.data, so payload.object.payment
  console.log('[DEBUG] Attempting to extract payment from payload.object');
  console.log('[DEBUG] payload?.object:', JSON.stringify(payload?.object, null, 2));
  console.log('[DEBUG] payload?.object?.payment:', JSON.stringify(payload?.object?.payment, null, 2));
  
  // Try payload.object.payment first (Square webhook structure)
  // This handles: event.data.object.payment (Square webhook) -> payload.object.payment (after queue)
  // Also handle case where payload itself might be the payment object
  let payment: any = null;
  
  if (payload?.object?.payment) {
    payment = payload.object.payment;
    console.log('[DEBUG] Found payment at payload.object.payment');
  } else if (payload?.object && typeof payload.object === 'object' && 'id' in payload.object) {
    // payload.object might be the payment directly
    payment = payload.object;
    console.log('[DEBUG] Found payment at payload.object');
  } else if (payload && typeof payload === 'object' && 'id' in payload && 'location_id' in payload) {
    // payload itself might be the payment
    payment = payload;
    console.log('[DEBUG] Found payment at payload (direct)');
  }
  
  console.log('[DEBUG] Final extracted payment:', JSON.stringify(payment, null, 2));

  if (!payment) {
    console.error('[DEBUG] ERROR: Payment object is missing');
    console.error('[DEBUG] Full payload structure:', JSON.stringify(payload, null, 2));
    console.error('[DEBUG] Full job.data structure:', JSON.stringify(job.data, null, 2));
    throw new SaleValidationError(
      'Missing payment object in payload',
      { payload: JSON.stringify(payload), jobData: JSON.stringify(job.data) },
    );
  }

  console.log('[DEBUG] Validating payment object fields...');
  
  if (!payment || typeof payment !== 'object') {
    console.error('[DEBUG] ERROR: Payment is not a valid object');
    throw new SaleValidationError(
      'Payment is not a valid object',
      { payment: JSON.stringify(payment) },
    );
  }
  
  if (!payment.id) {
    console.error('[DEBUG] ERROR: Payment object missing id');
    console.error('[DEBUG] Payment object:', JSON.stringify(payment, null, 2));
    throw new SaleValidationError(
      'Payment object missing id',
      { payment: JSON.stringify(payment) },
    );
  }
  console.log('[DEBUG] ✓ Payment ID found:', payment.id);

  if (!payment.location_id) {
    console.error('[DEBUG] ERROR: Payment object missing location_id');
    throw new SaleValidationError(
      'Payment object missing location_id',
      { payment: JSON.stringify(payment) },
    );
  }
  console.log('[DEBUG] ✓ Location ID found:', payment.location_id);

  const squareId = payment.id;
  const locationId = payment.location_id;
  const orderId = payment.order_id;
  const createdAt = payment.created_at
    ? new Date(payment.created_at)
    : new Date();

  console.log('[DEBUG] Payment details extracted:', {
    squareId,
    locationId,
    orderId,
    createdAt: createdAt.toISOString(),
  });

  // Check if sale with squareId already exists (idempotency)
  console.log('[DEBUG] Checking for existing sale with squareId:', squareId);
  const existing = await getPrisma().sale.findUnique({
    where: { squareId },
  });
  if (existing) {
    console.log(`[DEBUG] Sale ${squareId} already exists, skipping (idempotent)`);
    return;
  }
  console.log('[DEBUG] ✓ No existing sale found, proceeding...');

  // Phase 2: Fetch Order Data from Square (or use test data)
  console.log('[DEBUG] Validating order_id...');
  if (!orderId) {
    console.error('[DEBUG] ERROR: Payment object missing order_id');
    throw new SaleValidationError(
      'Payment object missing order_id',
      { payment: JSON.stringify(payment) },
    );
  }
  console.log('[DEBUG] ✓ Order ID found:', orderId);

  let order;
  
  // Check if this is a test event with embedded order data
  const testOrderData = job.data?.payload?._testOrderData;
  if (testOrderData) {
    console.log('[DEBUG] Using test order data (bypassing Square API)');
    order = testOrderData;
  } else {
    try {
      console.log('[DEBUG] Fetching order from Square API...');
      const client = getSquareClient();
      console.log('[DEBUG] Square client initialized, calling orders.get()');
      const response = await client.orders.get({
        orderId: orderId,
      });
      console.log('[DEBUG] Square API response received');
      order = response.order;

      if (!order) {
        console.error('[DEBUG] ERROR: Order not found in Square response');
        throw new SaleValidationError(
          `Order ${orderId} not found in Square`,
          { orderId, squareId },
        );
      }
      console.log('[DEBUG] ✓ Order fetched successfully, order ID:', order.id);
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
  console.log('[DEBUG] Extracting line items from order...');
  const orderLineItems = order.lineItems || [];
  console.log('[DEBUG] Found', orderLineItems.length, 'line items in order');

  if (!orderLineItems || orderLineItems.length === 0) {
    console.error('[DEBUG] ERROR: Order has no line items');
    throw new SaleValidationError(
      'Order has no line items',
      { orderId, squareId, locationId },
    );
  }

  // Map Square line items to SaleItemInput
  // Note: This assumes products are mapped by SKU or variation ID
  // You may need to adjust the mapping logic based on your product setup
  console.log('[DEBUG] Mapping line items to SaleItemInput...');
  const lineItems: SaleItemInput[] = [];

  for (let i = 0; i < orderLineItems.length; i++) {
    const orderLineItem = orderLineItems[i];
    console.log(`[DEBUG] Processing line item ${i + 1}/${orderLineItems.length}:`, {
      uid: orderLineItem.uid,
      name: orderLineItem.name,
      catalogObjectId: orderLineItem.catalogObjectId,
      quantity: orderLineItem.quantity,
      // Note: catalogVersion is a BigInt, so we convert it to string
      catalogVersion: orderLineItem.catalogVersion?.toString(),
    });
    if (!orderLineItem.uid && !orderLineItem.catalogObjectId) {
      console.warn(`[DEBUG] WARNING: Skipping line item ${i + 1} without uid or catalogObjectId:`, orderLineItem);
      continue;
    }

    // Map variation ID to product using CatalogMapping
    const catalogObjectId = orderLineItem.catalogObjectId;
    const itemName = orderLineItem.name;
    console.log(`[DEBUG] Looking up product for line item ${i + 1}:`, {
      catalogObjectId,
      itemName,
    });

    // Validate catalogObjectId exists (this is the variation ID)
    if (!catalogObjectId) {
      console.warn(`[DEBUG] WARNING: Line item ${i + 1} missing catalogObjectId, skipping`);
      continue;
    }

    // Map variation to product using CatalogMapping
    let productId: string;
    try {
      productId = await mapVariationToProduct(
        catalogObjectId,
        locationId,
        getPrisma(),
      );
      console.log(`[DEBUG] ✓ Product mapped for line item ${i + 1}:`, {
        variationId: catalogObjectId,
        productId,
        locationId,
      });
    } catch (error) {
      if (error instanceof UnmappedVariationError) {
        console.error(`[DEBUG] ERROR: Unmapped variation for line item ${i + 1}:`, {
          variationId: error.squareVariationId,
          locationId: error.locationId,
          message: error.message,
        });
        throw new SaleValidationError(
          `Square variation is not mapped to a product. Variation ID: ${error.squareVariationId}, Location ID: ${error.locationId}. ` +
            `Please run catalog sync to create mappings.`,
          {
            variationId: error.squareVariationId,
            locationId: error.locationId,
            orderLineItem: safeStringify(orderLineItem),
            orderId,
            squareId,
          },
        );
      }
      // Re-throw other errors
      throw error;
    }

    const quantity = orderLineItem.quantity
      ? parseInt(orderLineItem.quantity, 10)
      : 1;
    console.log(`[DEBUG] Line item ${i + 1} quantity:`, quantity);

    if (quantity <= 0) {
      console.error(`[DEBUG] ERROR: Line item ${i + 1} has invalid quantity`);
      throw new SaleValidationError(
        'Line item quantity must be positive',
        { orderLineItem: safeStringify(orderLineItem) },
      );
    }

    // Get price from line item
    // totalMoney is the total price for the quantity (in cents)
    // basePriceMoney would be the unit price, but we'll calculate from totalMoney
    const totalMoney = orderLineItem.totalMoney;
    console.log(`[DEBUG] Line item ${i + 1} totalMoney:`, totalMoney);
    
    if (!totalMoney || totalMoney.amount === undefined || totalMoney.amount === null) {
      console.error(`[DEBUG] ERROR: Line item ${i + 1} missing price information`);
      throw new SaleValidationError(
        'Line item missing price information',
        { orderLineItem: safeStringify(orderLineItem) },
      );
    }

    // Convert from cents to dollars and calculate unit price
    // totalMoney.amount is a bigint, convert to string first
    const totalPriceInDollars = new Prisma.Decimal(totalMoney.amount.toString()).div(100);
    const unitPrice = totalPriceInDollars.div(quantity);
    console.log(`[DEBUG] Line item ${i + 1} pricing:`, {
      totalPriceInDollars: totalPriceInDollars.toString(),
      unitPrice: unitPrice.toString(),
    });

    lineItems.push({
      productId: productId,
      quantitySold: quantity,
      salePrice: new Prisma.Decimal(unitPrice),
    });
    console.log(`[DEBUG] ✓ Line item ${i + 1} mapped successfully`);
  }

  console.log('[DEBUG] Total line items mapped:', lineItems.length);
  if (lineItems.length === 0) {
    console.error('[DEBUG] ERROR: No valid line items found after mapping');
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
  console.log('[DEBUG] Starting transaction to create sale and process items...');
  let saleId: string;
  let itemCount: number;

  try {
    const result = await getPrisma().$transaction(
      async (tx) => {
        // Find or create Location based on Square location ID
        let location = await tx.location.findUnique({
          where: { squareId: locationId },
        });

        if (!location) {
          console.log('[DEBUG] [TX] Location not found, creating new location with squareId:', locationId);
          // Fetch location details from Square API if needed, or create with minimal data
          // For now, create with squareId only - name/address can be updated later
          location = await tx.location.create({
            data: {
              squareId: locationId,
              name: `Location ${locationId}`, // Temporary name, can be updated via sync
              isActive: true,
            },
          });
          console.log('[DEBUG] [TX] Created location:', location.id);
        } else {
          console.log('[DEBUG] [TX] Found existing location:', location.id);
        }

        console.log('[DEBUG] [TX] Creating Sale record...');
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
        console.log('[DEBUG] [TX] ✓ Sale record created:', sale.id);

        const saleItems: SaleItemOutput[] = [];

        // Process each line item
        console.log('[DEBUG] [TX] Processing', lineItems.length, 'line items...');
        for (let i = 0; i < lineItems.length; i++) {
          const lineItem = lineItems[i];
          console.log(`[DEBUG] [TX] Processing line item ${i + 1}/${lineItems.length}:`, {
            productId: lineItem.productId,
            quantitySold: lineItem.quantitySold,
            salePrice: lineItem.salePrice.toString(),
          });
          try {
            console.log(`[DEBUG] [TX] Calling processSaleItem for line item ${i + 1}...`);
            const saleItem = await processSaleItem(
              sale.id,
              lineItem.productId,
              location.id, // Use Location UUID, not Square location ID
              lineItem.quantitySold,
              new Prisma.Decimal(lineItem.salePrice),
              tx,
            );
            console.log(`[DEBUG] [TX] ✓ Line item ${i + 1} processed:`, {
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

        // Calculate sale totals
        console.log('[DEBUG] [TX] Calculating sale totals...');
        const totals = calculateSaleTotals(saleItems);
        console.log('[DEBUG] [TX] Sale totals:', {
          totalRevenue: totals.totalRevenue.toString(),
          totalCost: totals.totalCost.toString(),
          grossProfit: totals.grossProfit.toString(),
        });

        // Update Sale record with totals
        console.log('[DEBUG] [TX] Updating Sale record with totals...');
        await tx.sale.update({
          where: { id: sale.id },
          data: {
            totalRevenue: totals.totalRevenue,
            totalCost: totals.totalCost,
            grossProfit: totals.grossProfit,
          },
        });
        console.log('[DEBUG] [TX] ✓ Sale record updated');

        return { saleId: sale.id, itemCount: saleItems.length };
      },
      {
        timeout: 30000, // 30 second timeout
      },
    );

    saleId = result.saleId;
    itemCount = result.itemCount;

    // Phase 5: Success
    console.log('[DEBUG] ========================================');
    console.log('[DEBUG] ✓ Sale processed successfully!');
    console.log('[DEBUG] Sale ID:', saleId);
    console.log('[DEBUG] Square ID:', squareId);
    console.log('[DEBUG] Location ID:', locationId);
    console.log('[DEBUG] Item Count:', itemCount);
    console.log('[DEBUG] ========================================');
  } catch (error) {
    // Error handling
    if (error instanceof UnmappedVariationError) {
      console.error('Unmapped variation error:', {
        variationId: error.squareVariationId,
        locationId: error.locationId,
        message: error.message,
        squareId: squareId,
      });
      // Re-throw as SaleValidationError (already converted above, but handle here for safety)
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