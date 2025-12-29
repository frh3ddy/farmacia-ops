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

  @Post('catalog/cleanup')
  async cleanupCatalog(@Body() body?: { deleteProducts?: boolean }) {
    try {
      const deleteProducts = body?.deleteProducts ?? true; // Default to true for fresh start
      
      // Delete in correct order to handle foreign key constraints
      // 1. Delete CostApproval (references products)
      const deletedCostApprovals = await this.prisma.costApproval.deleteMany({});
      
      // 2. Delete catalog mappings (references products)
      const deletedMappings = await this.prisma.catalogMapping.deleteMany({});
      
      // 3. Delete SupplierProduct (references products)
      const deletedSupplierProducts = await this.prisma.supplierProduct.deleteMany({});
      
      // 4. Delete SupplierCostHistory (references products)
      const deletedCostHistory = await this.prisma.supplierCostHistory.deleteMany({});
      
      // 5. Delete Inventory (references products)
      const deletedInventory = await this.prisma.inventory.deleteMany({});
      
      // 6. Delete SaleItem (references products) - need to delete sales first or sale items
      const deletedSaleItems = await this.prisma.saleItem.deleteMany({});
      
      // 7. Delete Placement (references products)
      const deletedPlacements = await this.prisma.placement.deleteMany({});
      
      let productsDeleted = 0;
      let productsUpdated = 0;

      if (deleteProducts) {
        // Now try to delete all products (should work after deleting all relationships)
        try {
          const deleted = await this.prisma.product.deleteMany({});
          productsDeleted = deleted.count;
        } catch (deleteError: any) {
          // If deletion still fails, fall back to clearing fields
          console.warn('[CATALOG_CLEANUP] Could not delete products, clearing Square fields instead:', deleteError.message);
          const updated = await this.prisma.product.updateMany({
            data: {
              squareProductName: null,
              squareDescription: null,
              squareImageUrl: null,
              squareVariationName: null,
              squareDataSyncedAt: null,
            },
          });
          productsUpdated = updated.count;
        }
      } else {
        // Just clear Square-related fields from all products
        const updated = await this.prisma.product.updateMany({
          data: {
            squareProductName: null,
            squareDescription: null,
            squareImageUrl: null,
            squareVariationName: null,
            squareDataSyncedAt: null,
          },
        });
        productsUpdated = updated.count;
      }

      return {
        success: true,
        message: deleteProducts && productsDeleted > 0 
          ? 'Catalog cleanup completed - all related records and products deleted'
          : 'Catalog cleanup completed - related records deleted, Square fields cleared from products',
        data: {
          costApprovalsDeleted: deletedCostApprovals.count,
          mappingsDeleted: deletedMappings.count,
          supplierProductsDeleted: deletedSupplierProducts.count,
          costHistoryDeleted: deletedCostHistory.count,
          inventoryDeleted: deletedInventory.count,
          saleItemsDeleted: deletedSaleItems.count,
          placementsDeleted: deletedPlacements.count,
          productsDeleted,
          productsUpdated,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      
      console.error('[CATALOG_CLEANUP] Error cleaning up catalog:', errorMessage);

      return {
        success: false,
        message: `Catalog cleanup failed: ${errorMessage}`,
        error: errorMessage,
      };
    }
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

