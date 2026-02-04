import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SquareClient, SquareEnvironment } from 'square';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

// Currency constant for Mexico
const CURRENCY = 'MXN';

export interface CreateProductInput {
  name: string;
  sku?: string;
  description?: string;
  sellingPrice: number; // In MXN (e.g., 45.50)
  costPrice?: number; // Initial cost price in MXN
  initialStock?: number; // Initial inventory quantity
  locationId: string; // Required for inventory and Square sync
  syncToSquare?: boolean; // Default true
}

export interface UpdatePriceInput {
  productId: string;
  sellingPrice: number; // New price in MXN
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

      this.squareClient = new SquareClient({
        token: squareAccessToken,
        environment: squareEnvironment,
      });
    }
    return this.squareClient;
  }

  /**
   * Convert MXN amount to cents (Square uses smallest currency unit)
   */
  private toCents(amount: number): bigint {
    return BigInt(Math.round(amount * 100));
  }

  /**
   * Convert cents to MXN
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

    this.logger.log(`[PRODUCT] Creating product: ${name}, SKU: ${sku || 'none'}, Price: $${sellingPrice} MXN`);

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
      this.logger.log(`[PRODUCT] Created initial inventory: ${initialStock} units @ $${costPrice} MXN`);
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

    this.logger.log(`[PRODUCT] Updating price for product ${productId} to $${sellingPrice} MXN`);

    if (sellingPrice < 0) {
      throw new BadRequestException('Selling price cannot be negative');
    }

    // Find product with catalog mapping
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        catalogMappings: {
          where: { locationId },
        },
      },
    });

    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    const mapping = product.catalogMappings[0];
    const previousPrice = mapping ? this.fromCents(Number(mapping.priceCents)) : null;
    let squareSynced = false;

    // Step 1: Update in Square if applicable
    if (syncToSquare && mapping && !mapping.squareVariationId.startsWith('local_')) {
      try {
        await this.updatePriceInSquare(mapping.squareVariationId, sellingPrice);
        squareSynced = true;
        this.logger.log(`[PRODUCT] Price updated in Square for variation ${mapping.squareVariationId}`);
      } catch (error) {
        this.logger.error(`[PRODUCT] Failed to update price in Square: ${error}`);
        // Continue with local update
      }
    }

    // Step 2: Update local catalog mapping
    if (mapping) {
      await this.prisma.catalogMapping.update({
        where: { id: mapping.id },
        data: {
          priceCents: new Prisma.Decimal(this.toCents(sellingPrice).toString()),
          priceSyncedAt: new Date(),
        },
      });
    } else {
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
        ? `Price updated to $${sellingPrice} MXN and synced to Square`
        : `Price updated to $${sellingPrice} MXN locally`,
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

    // Update with new price
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
