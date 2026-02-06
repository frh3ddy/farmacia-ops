import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SquareClient, SquareEnvironment } from 'square';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

// Currency constant - must match Square merchant account currency
// Square merchant is configured with USD
const CURRENCY = 'USD';

export interface CreateProductInput {
  name: string;
  sku?: string;
  description?: string;
  sellingPrice: number; // Price in dollars (e.g., 45.50)
  costPrice?: number; // Initial cost price in dollars
  initialStock?: number; // Initial inventory quantity
  locationId: string; // Required for inventory and Square sync
  syncToSquare?: boolean; // Default true
}

export interface UpdatePriceInput {
  productId: string;
  sellingPrice: number; // New price in dollars
  locationId: string;
  syncToSquare?: boolean;
}

export interface ProductResult {
  product: any;
  squareSynced: boolean;
  squareItemId?: string;
  squareVariationId?: string;
  inventoryCreated: boolean;
  message: string;
}

export interface PriceUpdateResult {
  product: any;
  previousPrice: number | null;
  newPrice: number;
  squareSynced: boolean;
  message: string;
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  private squareClient: SquareClient | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get or create Square client
   */
  private getSquareClient(): SquareClient {
    if (!this.squareClient) {
      const squareAccessToken = process.env.SQUARE_ACCESS_TOKEN?.trim();

      if (!squareAccessToken) {
        throw new Error('SQUARE_ACCESS_TOKEN environment variable is not set');
      }

      // Determine Square environment
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
      } else {
        squareEnvironment = SquareEnvironment.Production;
      }

      this.logger.log(`[SQUARE] Initializing Square client with environment: ${squareEnvironment === SquareEnvironment.Sandbox ? 'SANDBOX' : 'PRODUCTION'}`);
      this.logger.log(`[SQUARE] Environment vars: NODE_ENV=${nodeEnv}, SQUARE_ENVIRONMENT=${squareEnv}, RAILWAY_ENVIRONMENT=${railwayEnv}`);

      this.squareClient = new SquareClient({
        token: squareAccessToken,
        environment: squareEnvironment,
      });
    }
    return this.squareClient;
  }

  /**
   * Convert dollar amount to cents (Square uses smallest currency unit)
   */
  private toCents(amount: number): bigint {
    return BigInt(Math.round(amount * 100));
  }

  /**
   * Convert cents to dollars
   */
  private fromCents(cents: number | bigint | null): number | null {
    if (cents === null || cents === undefined) return null;
    return Number(cents) / 100;
  }

  /**
   * Create a new product and optionally sync to Square
   */
  async createProduct(input: CreateProductInput): Promise<ProductResult> {
    const {
      name,
      sku,
      description,
      sellingPrice,
      costPrice,
      initialStock,
      locationId,
      syncToSquare = true,
    } = input;

    this.logger.log(`[PRODUCT] Creating product: ${name}, SKU: ${sku || 'none'}, Price: $${sellingPrice} ${CURRENCY}`);

    // Validate inputs
    if (!name || name.trim().length === 0) {
      throw new BadRequestException('Product name is required');
    }
    if (sellingPrice < 0) {
      throw new BadRequestException('Selling price cannot be negative');
    }
    if (costPrice !== undefined && costPrice < 0) {
      throw new BadRequestException('Cost price cannot be negative');
    }
    if (initialStock !== undefined && initialStock < 0) {
      throw new BadRequestException('Initial stock cannot be negative');
    }

    // Check SKU uniqueness if provided
    if (sku) {
      const existingProduct = await this.prisma.product.findUnique({
        where: { sku },
      });
      if (existingProduct) {
        throw new BadRequestException(`A product with SKU "${sku}" already exists`);
      }
    }

    // Verify location exists
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
    });
    if (!location) {
      throw new NotFoundException(`Location ${locationId} not found`);
    }

    let squareItemId: string | undefined;
    let squareVariationId: string | undefined;
    let squareSynced = false;

    // Step 1: Create in Square (if enabled)
    if (syncToSquare) {
      try {
        const squareResult = await this.createProductInSquare({
          name,
          sku,
          description,
          sellingPrice,
          locationId: location.squareId || undefined,
        });
        squareItemId = squareResult.itemId;
        squareVariationId = squareResult.variationId;
        squareSynced = true;
        this.logger.log(`[PRODUCT] Created in Square: Item=${squareItemId}, Variation=${squareVariationId}`);
      } catch (error) {
        this.logger.error(`[PRODUCT] Failed to create in Square: ${error}`);
        // Continue without Square sync - product will be local only
      }
    }

    // Step 2: Create product in our database
    const product = await this.prisma.product.create({
      data: {
        name: name.trim(),
        sku: sku?.trim() || null,
        squareProductName: name.trim(),
        squareDescription: description || null,
        squareVariationName: 'Regular', // Simple product
        squareDataSyncedAt: squareSynced ? new Date() : null,
      },
    });

    // Step 3: Create catalog mapping with price
    if (squareVariationId) {
      await this.prisma.catalogMapping.create({
        data: {
          squareVariationId,
          productId: product.id,
          locationId,
          priceCents: new Prisma.Decimal(this.toCents(sellingPrice).toString()),
          currency: CURRENCY,
          priceSyncedAt: new Date(),
        },
      });
    } else {
      // Create local-only mapping (no Square ID)
      await this.prisma.catalogMapping.create({
        data: {
          squareVariationId: `local_${product.id}`, // Local identifier
          productId: product.id,
          locationId,
          priceCents: new Prisma.Decimal(this.toCents(sellingPrice).toString()),
          currency: CURRENCY,
          priceSyncedAt: new Date(),
        },
      });
    }

    // Step 4: Create initial inventory if provided
    let inventoryCreated = false;
    if (initialStock && initialStock > 0 && costPrice !== undefined) {
      await this.prisma.inventory.create({
        data: {
          locationId,
          productId: product.id,
          quantity: initialStock,
          unitCost: new Prisma.Decimal(costPrice),
          receivedAt: new Date(),
          source: 'OPENING_BALANCE',
          costSource: 'MANUAL_INPUT',
        },
      });
      inventoryCreated = true;
      this.logger.log(`[PRODUCT] Created initial inventory: ${initialStock} units @ $${costPrice} ${CURRENCY}`);
    }

    // Fetch complete product with relations
    const completeProduct = await this.prisma.product.findUnique({
      where: { id: product.id },
      include: {
        catalogMappings: {
          include: { location: true },
        },
        inventories: true,
      },
    });

    return {
      product: completeProduct,
      squareSynced,
      squareItemId,
      squareVariationId,
      inventoryCreated,
      message: squareSynced
        ? `Product "${name}" created and synced to Square`
        : `Product "${name}" created locally (Square sync ${syncToSquare ? 'failed' : 'disabled'})`,
    };
  }

  /**
   * Create product in Square
   */
  private async createProductInSquare(input: {
    name: string;
    sku?: string;
    description?: string;
    sellingPrice: number;
    locationId?: string;
  }): Promise<{ itemId: string; variationId: string }> {
    const client = this.getSquareClient();
    const idempotencyKey = randomUUID();

    // Generate temporary IDs for the request
    const tempItemId = `#item_${idempotencyKey}`;
    const tempVariationId = `#variation_${idempotencyKey}`;

    const response = await client.catalog.object.upsert({
      idempotencyKey,
      object: {
        type: 'ITEM',
        id: tempItemId,
        itemData: {
          name: input.name,
          description: input.description || undefined,
          variations: [
            {
              type: 'ITEM_VARIATION',
              id: tempVariationId,
              itemVariationData: {
                itemId: tempItemId,
                name: 'Regular', // Simple product - single variation
                sku: input.sku || undefined,
                pricingType: 'FIXED_PRICING',
                priceMoney: {
                  amount: this.toCents(input.sellingPrice),
                  currency: CURRENCY,
                },
              },
            },
          ],
        },
      },
    });

    // Extract real IDs from response
    const catalogObject = response.catalogObject;
    if (!catalogObject) {
      throw new Error('No catalog object returned from Square');
    }

    const itemId = catalogObject.id;
    const itemData = (catalogObject as any).itemData;
    const variations = itemData?.variations || [];
    const variationId = variations[0]?.id;

    if (!itemId || !variationId) {
      throw new Error('Failed to get item/variation IDs from Square response');
    }

    return { itemId, variationId };
  }

  /**
   * Update product selling price and sync to Square
   */
  async updatePrice(input: UpdatePriceInput): Promise<PriceUpdateResult> {
    const { productId, sellingPrice, locationId, syncToSquare = true } = input;

    this.logger.log(`[PRODUCT] Updating price for product ${productId} to $${sellingPrice} ${CURRENCY}`);

    if (sellingPrice < 0) {
      throw new BadRequestException('Selling price cannot be negative');
    }

    // Find product with catalog mapping
    // Look for location-specific mapping first, then fall back to global mapping (locationId = null)
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        catalogMappings: {
          where: {
            OR: [
              { locationId },           // Location-specific mapping
              { locationId: null },     // Global mapping (from Square sync)
            ],
          },
          orderBy: {
            locationId: 'desc',  // Prefer location-specific (non-null) over global
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    // Prefer location-specific mapping, fall back to global
    const mapping = product.catalogMappings.find(m => m.locationId === locationId) 
                 || product.catalogMappings.find(m => m.locationId === null);
    const previousPrice = mapping ? this.fromCents(Number(mapping.priceCents)) : null;
    let squareSynced = false;

    this.logger.log(`[PRODUCT] Found ${product.catalogMappings.length} catalog mapping(s) for location ${locationId} (including global)`);
    if (mapping) {
      const mappingType = mapping.locationId === null ? 'GLOBAL' : 'LOCATION-SPECIFIC';
      this.logger.log(`[PRODUCT] Using ${mappingType} mapping: squareVariationId=${mapping.squareVariationId}, priceCents=${mapping.priceCents}, mappingLocationId=${mapping.locationId}`);
    } else {
      this.logger.log(`[PRODUCT] No existing catalog mapping found for this location or global`);
    }

    // Get location for Square sync
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
    });

    // Step 1: Update in Square if applicable
    if (syncToSquare && mapping) {
      // Check if this is a local-only product that needs to be synced to Square first
      if (mapping.squareVariationId.startsWith('local_')) {
        this.logger.log(`[PRODUCT] Product is local-only, attempting to sync to Square first...`);
        try {
          // Create the product in Square
          const squareResult = await this.createProductInSquare({
            name: product.name,
            sku: product.sku || undefined,
            description: product.squareDescription || undefined,
            sellingPrice,
            locationId: location?.squareId || undefined,
          });
          
          // Update the catalog mapping with the real Square variation ID
          await this.prisma.catalogMapping.update({
            where: { id: mapping.id },
            data: {
              squareVariationId: squareResult.variationId,
              priceCents: new Prisma.Decimal(this.toCents(sellingPrice).toString()),
              priceSyncedAt: new Date(),
            },
          });
          
          squareSynced = true;
          this.logger.log(`[PRODUCT] Product synced to Square: Item=${squareResult.itemId}, Variation=${squareResult.variationId}`);
        } catch (error) {
          this.logger.error(`[PRODUCT] Failed to sync local product to Square: ${error}`);
          // Continue with local update only
        }
      } else {
        // Product already exists in Square, just update the price
        try {
          await this.updatePriceInSquare(mapping.squareVariationId, sellingPrice);
          squareSynced = true;
          this.logger.log(`[PRODUCT] Price updated in Square for variation ${mapping.squareVariationId}`);
        } catch (error) {
          this.logger.error(`[PRODUCT] Failed to update price in Square: ${error}`);
          // Continue with local update
        }
      }
    }

    // Step 2: Update local catalog mapping (only if not already updated during Square sync)
    if (mapping && !squareSynced) {
      // Only update locally if Square sync didn't already update the mapping
      await this.prisma.catalogMapping.update({
        where: { id: mapping.id },
        data: {
          priceCents: new Prisma.Decimal(this.toCents(sellingPrice).toString()),
          priceSyncedAt: new Date(),
        },
      });
    } else if (mapping && squareSynced && !mapping.squareVariationId.startsWith('local_')) {
      // For existing Square products, update the local price after Square sync
      await this.prisma.catalogMapping.update({
        where: { id: mapping.id },
        data: {
          priceCents: new Prisma.Decimal(this.toCents(sellingPrice).toString()),
          priceSyncedAt: new Date(),
        },
      });
    } else if (!mapping) {
      // Create new mapping if none exists
      await this.prisma.catalogMapping.create({
        data: {
          squareVariationId: `local_${productId}`,
          productId,
          locationId,
          priceCents: new Prisma.Decimal(this.toCents(sellingPrice).toString()),
          currency: CURRENCY,
          priceSyncedAt: new Date(),
        },
      });
    }

    // Fetch updated product
    const updatedProduct = await this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        catalogMappings: {
          include: { location: true },
        },
      },
    });

    return {
      product: updatedProduct,
      previousPrice,
      newPrice: sellingPrice,
      squareSynced,
      message: squareSynced
        ? `Price updated to $${sellingPrice} ${CURRENCY} and synced to Square`
        : `Price updated to $${sellingPrice} ${CURRENCY} locally`,
    };
  }

  /**
   * Update price in Square
   */
  private async updatePriceInSquare(variationId: string, newPrice: number): Promise<void> {
    const client = this.getSquareClient();

    // First, fetch the current object to get its version
    const retrieveResponse = await client.catalog.object.get({
      objectId: variationId,
    });

    const currentObject = retrieveResponse.object;
    if (!currentObject) {
      throw new Error(`Variation ${variationId} not found in Square`);
    }

    const variationData = (currentObject as any).itemVariationData;
    if (!variationData) {
      throw new Error(`Invalid variation data for ${variationId}`);
    }

    try {
      // Update the variation with new price
      await client.catalog.object.upsert({
        idempotencyKey: randomUUID(),
        object: {
          type: 'ITEM_VARIATION',
          id: variationId,
          version: currentObject.version,
          itemVariationData: {
            itemId: variationData.itemId,
            name: variationData.name || 'Regular',
            sku: variationData.sku,
            pricingType: 'FIXED_PRICING',
            priceMoney: {
              amount: this.toCents(newPrice),
              currency: CURRENCY,
            },
          },
        },
      });
    } catch (error: any) {
      // Check for location enablement error and provide clear message
      const errorBody = error?.body || error?.message || '';
      const errorString = typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody);
      
      if (errorString.includes('is not enabled')) {
        // Extract details from error for better messaging
        const parentItemId = variationData.itemId;
        this.logger.error(`[PRODUCT] Square price update failed: Item or variation not enabled at required location(s). Parent Item ID: ${parentItemId}, Variation ID: ${variationId}`);
        throw new Error(
          `Cannot update price in Square: The item (${parentItemId}) or variation (${variationId}) is not enabled at the required location(s). ` +
          `Please enable the item at all locations in Square Dashboard (Items & Orders → Item Library → Find item → Locations tab), ` +
          `or update the price directly in Square Dashboard.`
        );
      }
      throw error;
    }
  }

  /**
   * Get all products with prices
   */
  async getProducts(locationId?: string) {
    const products = await this.prisma.product.findMany({
      include: {
        category: true,
        catalogMappings: {
          where: locationId ? { locationId } : undefined,
          include: {
            location: true,
          },
        },
        inventories: locationId
          ? {
              where: { locationId },
            }
          : true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Transform products to include computed fields
    const transformedProducts = products.map((product) => {
      const mapping = product.catalogMappings[0];
      const totalInventory = product.inventories.reduce((sum, inv) => sum + inv.quantity, 0);
      
      return {
        ...product,
        sellingPrice: mapping ? this.fromCents(Number(mapping.priceCents)) : null,
        currency: mapping?.currency || CURRENCY,
        totalInventory,
        hasSquareSync: mapping ? !mapping.squareVariationId.startsWith('local_') : false,
      };
    });

    return {
      success: true,
      data: transformedProducts,
      count: transformedProducts.length,
    };
  }

  /**
   * Get single product by ID
   */
  async getProduct(productId: string, locationId?: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        category: true,
        catalogMappings: {
          where: locationId ? { locationId } : undefined,
          include: {
            location: true,
          },
        },
        inventories: locationId
          ? {
              where: { locationId },
            }
          : true,
        receivings: {
          take: 10,
          orderBy: { receivedAt: 'desc' },
        },
      },
    });

    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    const mapping = product.catalogMappings[0];
    const totalInventory = product.inventories.reduce((sum, inv) => sum + inv.quantity, 0);
    
    // Calculate average cost from inventory
    const totalCost = product.inventories.reduce(
      (sum, inv) => sum + (inv.quantity * Number(inv.unitCost)),
      0
    );
    const averageCost = totalInventory > 0 ? totalCost / totalInventory : null;

    return {
      success: true,
      data: {
        ...product,
        sellingPrice: mapping ? this.fromCents(Number(mapping.priceCents)) : null,
        currency: mapping?.currency || CURRENCY,
        totalInventory,
        averageCost,
        hasSquareSync: mapping ? !mapping.squareVariationId.startsWith('local_') : false,
      },
    };
  }
}
