import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SaleQueue } from '../queues/sale.queue';

export interface TestSaleLineItem {
  productId: string;
  quantity: number;
  priceOverride?: number; // Optional price override in dollars
}

export interface CreateTestSaleInput {
  locationId: string;
  lineItems: TestSaleLineItem[];
}

export interface ProductWithInventory {
  id: string;
  name: string;
  sku: string | null;
  displayName: string;
  sellingPrice: number | null;
  totalInventory: number;
  squareVariationId: string | null;
  hasSquareMapping: boolean;
}

@Injectable()
export class SalesTestService {
  private readonly logger = new Logger(SalesTestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly saleQueue: SaleQueue,
  ) {}

  /**
   * Get all locations with their Square IDs
   */
  async getLocations() {
    const locations = await this.prisma.location.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        squareId: true,
        isActive: true,
      },
      orderBy: { name: 'asc' },
    });

    return locations.map(loc => ({
      ...loc,
      hasSquareId: !!loc.squareId,
    }));
  }

  /**
   * Get products with inventory for a specific location
   * Only returns products that have:
   * 1. Inventory at the location
   * 2. A valid Square catalog mapping
   */
  async getProductsWithInventory(locationId: string): Promise<ProductWithInventory[]> {
    // First verify location exists
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
    });

    if (!location) {
      throw new Error(`Location ${locationId} not found`);
    }

    // Get products with inventory and catalog mappings
    const products = await this.prisma.product.findMany({
      where: {
        inventories: {
          some: {
            locationId: locationId,
            quantity: { gt: 0 },
          },
        },
      },
      include: {
        inventories: {
          where: {
            locationId: locationId,
            quantity: { gt: 0 },
          },
        },
        catalogMappings: {
          where: {
            OR: [
              { locationId: locationId },
              { locationId: null }, // Global mappings
            ],
          },
          orderBy: {
            locationId: 'desc', // Location-specific first
          },
          take: 1,
        },
      },
      orderBy: { name: 'asc' },
    });

    return products.map(product => {
      const totalInventory = product.inventories.reduce((sum, inv) => sum + inv.quantity, 0);
      const mapping = product.catalogMappings[0];
      const hasSquareMapping = !!mapping && !mapping.squareVariationId.startsWith('local_');

      return {
        id: product.id,
        name: product.name,
        sku: product.sku,
        displayName: product.squareProductName || product.squareVariationName || product.name,
        sellingPrice: mapping ? Number(mapping.priceCents) / 100 : null,
        totalInventory,
        squareVariationId: hasSquareMapping ? mapping.squareVariationId : null,
        hasSquareMapping,
      };
    });
  }

  /**
   * Create a test sale by simulating a Square webhook
   * This creates a mock payment.created event with the specified products
   */
  async createTestSale(input: CreateTestSaleInput) {
    const { locationId, lineItems } = input;

    // Validate location
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { id: true, name: true, squareId: true },
    });

    if (!location) {
      throw new Error(`Location ${locationId} not found`);
    }

    if (!location.squareId) {
      throw new Error(`Location ${location.name} does not have a Square ID. Cannot process sales.`);
    }

    // Validate and prepare line items
    const preparedLineItems: Array<{
      product: any;
      quantity: number;
      price: number;
      squareVariationId: string;
    }> = [];

    for (const item of lineItems) {
      // Get product with mapping
      const product = await this.prisma.product.findUnique({
        where: { id: item.productId },
        include: {
          catalogMappings: {
            where: {
              OR: [
                { locationId: locationId },
                { locationId: null },
              ],
            },
            orderBy: { locationId: 'desc' },
            take: 1,
          },
          inventories: {
            where: {
              locationId: locationId,
              quantity: { gt: 0 },
            },
          },
        },
      });

      if (!product) {
        throw new Error(`Product ${item.productId} not found`);
      }

      const mapping = product.catalogMappings[0];
      if (!mapping || mapping.squareVariationId.startsWith('local_')) {
        throw new Error(
          `Product "${product.name}" does not have a valid Square catalog mapping. ` +
          `Please sync the catalog first.`
        );
      }

      // Check inventory
      const totalInventory = product.inventories.reduce((sum, inv) => sum + inv.quantity, 0);
      if (totalInventory < item.quantity) {
        throw new Error(
          `Insufficient inventory for "${product.name}". ` +
          `Requested: ${item.quantity}, Available: ${totalInventory}`
        );
      }

      // Get price (use override or mapping price)
      const price = item.priceOverride ?? (Number(mapping.priceCents) / 100);
      if (price <= 0) {
        throw new Error(`Product "${product.name}" has no valid price`);
      }

      preparedLineItems.push({
        product,
        quantity: item.quantity,
        price,
        squareVariationId: mapping.squareVariationId,
      });
    }

    // Generate unique IDs for the test
    const timestamp = Date.now();
    const paymentId = `test_payment_${timestamp}`;
    const orderId = `test_order_${timestamp}`;
    const eventId = `test_event_${timestamp}`;

    // Calculate totals
    let totalAmount = 0;
    const orderLineItems = preparedLineItems.map((item, index) => {
      const lineTotal = item.price * item.quantity;
      totalAmount += lineTotal;

      return {
        uid: `line_item_${index}_${timestamp}`,
        name: item.product.name,
        quantity: String(item.quantity),
        catalogObjectId: item.squareVariationId,
        catalogVersion: 1,
        basePriceMoney: {
          amount: Math.round(item.price * 100),
          currency: 'MXN',
        },
        totalMoney: {
          amount: Math.round(lineTotal * 100),
          currency: 'MXN',
        },
      };
    });

    // Create mock Square webhook event
    // Note: The worker expects this structure:
    // event.data.object.payment (for payment info)
    // Then it fetches the order from Square API using order_id
    // For testing, we bypass the Square API call by including _testOrderData
    
    const mockEvent = {
      type: 'payment.created',
      event_id: eventId,
      data: {
        type: 'payment',
        id: paymentId,
        object: {
          payment: {
            id: paymentId,
            location_id: location.squareId,
            order_id: orderId,
            created_at: new Date().toISOString(),
            status: 'COMPLETED',
            amount_money: {
              amount: Math.round(totalAmount * 100),
              currency: 'MXN',
            },
            total_money: {
              amount: Math.round(totalAmount * 100),
              currency: 'MXN',
            },
          },
        },
        // Include the order data for the worker to use (bypasses Square API)
        _testOrderData: {
          id: orderId,
          locationId: location.squareId,
          lineItems: orderLineItems,
          totalMoney: {
            amount: Math.round(totalAmount * 100),
            currency: 'MXN',
          },
        },
      },
    };

    this.logger.log(`[SALES_TEST] Creating test sale:`);
    this.logger.log(`[SALES_TEST]   Payment ID: ${paymentId}`);
    this.logger.log(`[SALES_TEST]   Order ID: ${orderId}`);
    this.logger.log(`[SALES_TEST]   Location: ${location.name} (${location.squareId})`);
    this.logger.log(`[SALES_TEST]   Line Items: ${preparedLineItems.length}`);
    this.logger.log(`[SALES_TEST]   Total: $${totalAmount.toFixed(2)}`);

    // Enqueue the sale for processing
    await this.saleQueue.enqueue(mockEvent);

    return {
      success: true,
      message: 'Test sale enqueued successfully',
      data: {
        eventId,
        paymentId,
        orderId,
        locationId: location.id,
        locationName: location.name,
        squareLocationId: location.squareId,
        lineItems: preparedLineItems.map(item => ({
          productId: item.product.id,
          productName: item.product.name,
          quantity: item.quantity,
          unitPrice: item.price,
          lineTotal: item.price * item.quantity,
          squareVariationId: item.squareVariationId,
        })),
        totalAmount,
      },
    };
  }

  /**
   * Get queue status for monitoring
   */
  async getQueueStatus() {
    // Note: This would require access to the BullMQ queue instance
    // For now, return a placeholder
    return {
      queueName: 'sales',
      status: 'active',
      note: 'Check worker logs for detailed queue status',
    };
  }
}
