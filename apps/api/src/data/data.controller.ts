import { Controller, Get, Post, Body } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('api')
export class DataController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('catalog/mappings')
  async getCatalogMappings() {
    const mappings = await this.prisma.catalogMapping.findMany({
      include: {
        product: true,
        location: true,
      },
      orderBy: {
        syncedAt: 'desc',
      },
    });

    return {
      success: true,
      data: mappings,
      count: mappings.length,
    };
  }

  @Get('products')
  async getProducts() {
    const products = await this.prisma.product.findMany({
      include: {
        category: true,
        catalogMappings: {
          include: {
            location: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      success: true,
      data: products,
      count: products.length,
    };
  }

  @Get('sales')
  async getSales() {
    const sales = await this.prisma.sale.findMany({
      include: {
        items: {
          include: {
            product: true,
          },
        },
        location: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      success: true,
      data: sales,
      count: sales.length,
    };
  }

  @Get('inventory')
  async getInventory() {
    const inventory = await this.prisma.inventory.findMany({
      include: {
        product: true,
        location: true,
      },
      orderBy: {
        receivedAt: 'asc', // FIFO order
      },
    });

    return {
      success: true,
      data: inventory,
      count: inventory.length,
    };
  }

  @Post('inventory/test')
  async createTestInventory(@Body() body: { squareVariationIds?: string[] }) {
    // Create test inventory for specified products
    // If squareVariationIds provided, find products via catalog mapping
    // Also creates inventory for a few other products for testing
    
    const squareVariationIds = body.squareVariationIds || [];
    const testLocationId = 'L60AMVPDZJ48F'; // Default test location
    
    // Find or create test location
    let location = await this.prisma.location.findUnique({
      where: { squareId: testLocationId },
    });
    
    if (!location) {
      location = await this.prisma.location.create({
        data: {
          squareId: testLocationId,
          name: 'Test Location',
          isActive: true,
        },
      });
    }

    const createdInventory = [];
    const productIdsUsed = new Set<string>();

    // Process specified squareVariationIds first
    if (squareVariationIds.length > 0) {
      for (const squareVariationId of squareVariationIds) {
        // Try to find mapping (try location-specific first, then global)
        let mapping = await this.prisma.catalogMapping.findFirst({
          where: {
            squareVariationId: squareVariationId,
            locationId: location.id,
          },
          include: { product: true },
        });

        if (!mapping) {
          mapping = await this.prisma.catalogMapping.findFirst({
            where: {
              squareVariationId: squareVariationId,
              locationId: null, // Global mapping
            },
            include: { product: true },
          });
        }

        if (mapping && mapping.product && !productIdsUsed.has(mapping.product.id)) {
          // Create test inventory batch
          const inventory = await this.prisma.inventory.create({
            data: {
              productId: mapping.product.id,
              locationId: location.id,
              quantity: 100, // Test quantity
              unitCost: 5.0, // Test unit cost
              receivedAt: new Date(), // Received now
            },
            include: {
              product: true,
              location: true,
            },
          });
          createdInventory.push(inventory);
          productIdsUsed.add(mapping.product.id);
        }
      }
    }

    // Also create inventory for a few additional products (if not already created)
    const additionalProducts = await this.prisma.product.findMany({
      where: {
        id: {
          notIn: Array.from(productIdsUsed),
        },
      },
      take: 3, // Get up to 3 more products
    });

    for (const product of additionalProducts) {
      const inventory = await this.prisma.inventory.create({
        data: {
          productId: product.id,
          locationId: location.id,
          quantity: 100,
          unitCost: 5.0,
          receivedAt: new Date(),
        },
        include: {
          product: true,
          location: true,
        },
      });
      createdInventory.push(inventory);
      productIdsUsed.add(product.id);
    }

    return {
      success: true,
      message: `Created ${createdInventory.length} test inventory batch(es)`,
      data: createdInventory,
      count: createdInventory.length,
    };
  }
}

