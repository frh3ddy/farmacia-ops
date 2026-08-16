import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard, RoleGuard, Roles } from '../auth/guards/auth.guard';

@Controller('api')
@UseGuards(AuthGuard, RoleGuard)
export class DataController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Normalize product name by filtering out "Sin variación" and using proper fallback logic
   */
  private normalizeProductName(product: {
    squareProductName?: string | null;
    squareVariationName?: string | null;
    name: string;
  }): string {
    const cleanSquareName = product.squareProductName && 
      !product.squareProductName.toLowerCase().includes('sin variación') && 
      !product.squareProductName.toLowerCase().includes('no variation') &&
      product.squareProductName.trim().length > 0 
      ? product.squareProductName 
      : null;

    const cleanVarName = product.squareVariationName && 
      !product.squareVariationName.toLowerCase().includes('sin variación') && 
      !product.squareVariationName.toLowerCase().includes('no variation') &&
      product.squareVariationName.trim().length > 0 
      ? product.squareVariationName 
      : null;

    const fallbackName = product.name && product.name.trim().length > 0
      ? product.name
      : 'Unknown Product';

    return cleanSquareName || cleanVarName || fallbackName;
  }

  @Get('catalog/mappings')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
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
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async getProducts() {
    const products = await this.prisma.product.findMany({
      include: {
        category: true,
        catalogMappings: {
          include: {
            location: true,
          },
        },
        suppliers: {
          select: {
            id: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Add supplier count to each product
    const productsWithSupplierCount = products.map((product) => ({
      ...product,
      supplierCount: product.suppliers?.length || 0,
    }));

    return {
      success: true,
      data: productsWithSupplierCount,
      count: productsWithSupplierCount.length,
    };
  }

  @Get('sales')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
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
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
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

    // Normalize product names to filter out "Sin variación" and use proper fallback
    const normalizedInventory = inventory.map(item => ({
      ...item,
      product: item.product ? {
        ...item.product,
        name: this.normalizeProductName(item.product),
      } : item.product,
    }));

    return {
      success: true,
      data: normalizedInventory,
      count: normalizedInventory.length,
    };
  }

  @Post('catalog/cleanup')
  @Roles('OWNER')
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
      
      // 5. Delete InventoryReceiving (references Inventory via inventoryBatchId)
      await this.prisma.inventoryReceiving.deleteMany({});

      // 5b. Delete InventoryConsumption (RESTRICT fkey on Inventory)
      await this.prisma.inventoryConsumption.deleteMany({});

      // 6. Delete Inventory (references products)
      const deletedInventory = await this.prisma.inventory.deleteMany({});
      
      // 7. Delete SaleItem (references products) - need to delete sales first or sale items
      const deletedSaleItems = await this.prisma.saleItem.deleteMany({});
      
      // 8. Delete Placement (references products)
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

  // Full database wipe, including auth records (Employee/User/sessions).
  // Irreversible and self-lockout: after this call nobody, including OWNER,
  // can authenticate — the deployment must be reseeded with a new employee
  // before anyone can log back in. Requires an exact confirmation phrase
  // (not just the OWNER role) so it can't be triggered by a stray request.
  @Post('wipe/full')
  @Roles('OWNER')
  async wipeFullDatabase(@Body() body?: { confirm?: string }) {
    if (body?.confirm !== 'DELETE EVERYTHING') {
      return {
        success: false,
        message: 'Refused: pass { "confirm": "DELETE EVERYTHING" } to proceed. This deletes all data, including every Employee/User — nobody will be able to log in afterward.',
      };
    }

    try {
      const counts = await this.prisma.$transaction(async (tx) => {
        // Order matters: children (FK holders) before the parents they
        // reference, mirroring the schema's foreign key graph.
        const inventoryConsumption = await tx.inventoryConsumption.deleteMany({});
        const costApproval = await tx.costApproval.deleteMany({});
        const catalogMapping = await tx.catalogMapping.deleteMany({});
        const placement = await tx.placement.deleteMany({});
        const supplierCostHistory = await tx.supplierCostHistory.deleteMany({});
        const supplierProduct = await tx.supplierProduct.deleteMany({});
        const inventoryReceiving = await tx.inventoryReceiving.deleteMany({});
        const inventoryAdjustment = await tx.inventoryAdjustment.deleteMany({});
        const saleItem = await tx.saleItem.deleteMany({});
        const inventory = await tx.inventory.deleteMany({});
        const sale = await tx.sale.deleteMany({});
        const extractionBatch = await tx.extractionBatch.deleteMany({});
        const rackSection = await tx.rackSection.deleteMany({});
        const rack = await tx.rack.deleteMany({});
        const expense = await tx.expense.deleteMany({});
        const device = await tx.device.deleteMany({});
        const employeeLocationAssignment = await tx.employeeLocationAssignment.deleteMany({});
        const employeeSession = await tx.employeeSession.deleteMany({});
        const auditLog = await tx.auditLog.deleteMany({});
        const cutoverLock = await tx.cutoverLock.deleteMany({});
        const demandSignal = await tx.demandSignal.deleteMany({});
        const cutover = await tx.cutover.deleteMany({});
        const extractionSession = await tx.extractionSession.deleteMany({});
        const product = await tx.product.deleteMany({});
        const category = await tx.category.deleteMany({});
        const supplier = await tx.supplier.deleteMany({});
        const location = await tx.location.deleteMany({});
        const employee = await tx.employee.deleteMany({});
        const user = await tx.user.deleteMany({});

        return {
          inventoryConsumption: inventoryConsumption.count,
          costApproval: costApproval.count,
          catalogMapping: catalogMapping.count,
          placement: placement.count,
          supplierCostHistory: supplierCostHistory.count,
          supplierProduct: supplierProduct.count,
          inventoryReceiving: inventoryReceiving.count,
          inventoryAdjustment: inventoryAdjustment.count,
          saleItem: saleItem.count,
          inventory: inventory.count,
          sale: sale.count,
          extractionBatch: extractionBatch.count,
          rackSection: rackSection.count,
          rack: rack.count,
          expense: expense.count,
          device: device.count,
          employeeLocationAssignment: employeeLocationAssignment.count,
          employeeSession: employeeSession.count,
          auditLog: auditLog.count,
          cutoverLock: cutoverLock.count,
          demandSignal: demandSignal.count,
          cutover: cutover.count,
          extractionSession: extractionSession.count,
          product: product.count,
          category: category.count,
          supplier: supplier.count,
          location: location.count,
          employee: employee.count,
          user: user.count,
        };
      });

      return {
        success: true,
        message: 'Full database wipe completed. All Employee/User records are gone — reseed an employee before anyone can log in again.',
        data: counts,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[FULL_WIPE] Error wiping database:', errorMessage);
      return {
        success: false,
        message: `Full wipe failed: ${errorMessage}`,
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

