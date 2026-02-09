import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import { ProductsService, CreateProductInput, UpdatePriceInput } from './products.service';
import { AuthGuard, RoleGuard, LocationGuard, Roles } from '../auth/guards/auth.guard';
import { PrismaService } from '../prisma/prisma.service';

// DTOs
interface CreateProductDto {
  name: string;
  sku?: string;
  description?: string;
  sellingPrice: number;
  costPrice?: number;
  initialStock?: number;
  locationId?: string; // Optional - will use current location if not provided
  syncToSquare?: boolean;
}

interface UpdatePriceDto {
  sellingPrice: number;
  locationId?: string;
  syncToSquare?: boolean;
  applyToAllLocations?: boolean;  // If true, update price at all Square locations
}

// Helper functions
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getErrorStatus(error: unknown): number {
  if (error && typeof error === 'object' && 'status' in error) {
    return (error as any).status;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

@Controller('products')
@UseGuards(AuthGuard, RoleGuard, LocationGuard)
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Create a new product
   * POST /products
   * Roles: OWNER, MANAGER
   */
  @Post()
  @Roles('OWNER', 'MANAGER')
  @HttpCode(HttpStatus.CREATED)
  async createProduct(@Body() body: CreateProductDto, @Req() req: any) {
    try {
      // Validate required fields
      if (!body.name || body.name.trim().length === 0) {
        throw new HttpException(
          { success: false, message: 'Product name is required' },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (body.sellingPrice === undefined || body.sellingPrice === null) {
        throw new HttpException(
          { success: false, message: 'Selling price is required' },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Use provided locationId or current location
      const locationId = body.locationId || req.currentLocation?.locationId;
      if (!locationId) {
        throw new HttpException(
          { success: false, message: 'Location ID is required' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const input: CreateProductInput = {
        name: body.name,
        sku: body.sku,
        description: body.description,
        sellingPrice: body.sellingPrice,
        costPrice: body.costPrice,
        initialStock: body.initialStock,
        locationId,
        syncToSquare: body.syncToSquare !== false, // Default true
      };

      const result = await this.productsService.createProduct(input);

      return {
        success: true,
        message: result.message,
        data: {
          product: result.product,
          squareSynced: result.squareSynced,
          squareItemId: result.squareItemId,
          squareVariationId: result.squareVariationId,
          inventoryCreated: result.inventoryCreated,
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: getErrorMessage(error),
        },
        getErrorStatus(error),
      );
    }
  }

  /**
   * Get all products
   * GET /products
   * Roles: All authenticated users
   */
  @Get()
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async getProducts(@Query('locationId') locationId: string, @Req() req: any) {
    try {
      // Use query param or current location
      const targetLocationId = locationId || req.currentLocation?.locationId;
      
      const result = await this.productsService.getProducts(targetLocationId);
      return result;
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: getErrorMessage(error),
        },
        getErrorStatus(error),
      );
    }
  }

  /**
   * Get all products available from a specific supplier (for purchase orders / shopping list)
   * GET /products/supplier-catalog/:supplierId
   * Returns products with current cost, stock levels, and preferred status
   */
  @Get('supplier-catalog/:supplierId')
  @Roles('OWNER', 'MANAGER')
  async getSupplierCatalog(
    @Param('supplierId') supplierId: string,
    @Query('locationId') locationId: string,
    @Req() req: any,
  ) {
    try {
      const targetLocationId = locationId || req.currentLocation?.locationId;

      // Get all products this supplier provides
      const supplierProducts = await this.prisma.supplierProduct.findMany({
        where: { supplierId },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              sku: true,
              squareProductName: true,
              squareVariationName: true,
              squareImageUrl: true,
              inventories: targetLocationId
                ? { where: { locationId: targetLocationId } }
                : true,
            },
          },
        },
        orderBy: {
          product: { name: 'asc' },
        },
      });

      const products = supplierProducts.map((sp) => {
        const totalStock = sp.product.inventories.reduce((sum, inv) => sum + inv.quantity, 0);
        return {
          productId: sp.product.id,
          productName: sp.product.squareProductName || sp.product.name,
          sku: sp.product.sku,
          imageUrl: sp.product.squareImageUrl,
          lastCost: sp.cost.toString(),
          isPreferred: sp.isPreferred,
          notes: sp.notes,
          currentStock: totalStock,
        };
      });

      return { success: true, products };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to fetch supplier catalog: ${getErrorMessage(error)}` },
        getErrorStatus(error),
      );
    }
  }

  /**
   * Get suppliers for a product (from SupplierProduct table)
   * GET /products/:id/suppliers
   * Returns current cost per supplier, preferred status, and notes
   */
  @Get(':id/suppliers')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async getProductSuppliers(@Param('id') productId: string) {
    try {
      const supplierProducts = await this.prisma.supplierProduct.findMany({
        where: { productId },
        include: {
          supplier: {
            select: {
              id: true,
              name: true,
              contactInfo: true,
              isActive: true,
            },
          },
        },
        orderBy: {
          supplier: { name: 'asc' },
        },
      });

      const suppliers = supplierProducts.map((sp) => ({
        id: sp.supplier.id,
        name: sp.supplier.name,
        contactInfo: sp.supplier.contactInfo,
        isActive: sp.supplier.isActive,
        cost: sp.cost.toString(),
        isPreferred: sp.isPreferred,
        notes: sp.notes,
      }));

      return { success: true, suppliers };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to fetch product suppliers: ${getErrorMessage(error)}` },
        getErrorStatus(error),
      );
    }
  }

  /**
   * Get cost history for a product across all suppliers (from SupplierCostHistory table)
   * GET /products/:id/cost-history
   * Returns cost timeline grouped by supplier
   */
  @Get(':id/cost-history')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async getProductCostHistory(@Param('id') productId: string) {
    try {
      const costHistories = await this.prisma.supplierCostHistory.findMany({
        where: { productId },
        include: {
          supplier: {
            select: { id: true, name: true },
          },
        },
        orderBy: [
          { supplier: { name: 'asc' } },
          { effectiveAt: 'desc' },
        ],
      });

      // Group by supplier
      const groupedBySupplier = new Map<
        string,
        Array<{
          id: string;
          cost: string;
          effectiveAt: string;
          createdAt: string;
          source: string;
          isCurrent: boolean;
        }>
      >();

      for (const entry of costHistories) {
        const supplierId = entry.supplierId;
        if (!groupedBySupplier.has(supplierId)) {
          groupedBySupplier.set(supplierId, []);
        }
        groupedBySupplier.get(supplierId)!.push({
          id: entry.id,
          cost: entry.unitCost.toString(),
          effectiveAt: entry.effectiveAt.toISOString(),
          createdAt: entry.createdAt.toISOString(),
          source: entry.source,
          isCurrent: entry.isCurrent,
        });
      }

      // Convert to array format with supplier info
      const suppliers = Array.from(groupedBySupplier.entries()).map(([supplierId, history]) => {
        const firstEntry = costHistories.find((e) => e.supplierId === supplierId);
        return {
          supplierId,
          supplierName: firstEntry?.supplier.name || 'Unknown',
          costHistory: history,
        };
      });

      return { success: true, suppliers };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to fetch product cost history: ${getErrorMessage(error)}` },
        getErrorStatus(error),
      );
    }
  }

  /**
   * Get single product
   * GET /products/:id
   * Roles: All authenticated users
   * NOTE: Must be AFTER /products/:id/suppliers and /products/:id/cost-history
   * to prevent :id from catching those sub-routes
   */
  @Get(':id')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async getProduct(
    @Param('id') id: string,
    @Query('locationId') locationId: string,
    @Req() req: any,
  ) {
    try {
      const targetLocationId = locationId || req.currentLocation?.locationId;
      const result = await this.productsService.getProduct(id, targetLocationId);
      return result;
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: getErrorMessage(error),
        },
        getErrorStatus(error),
      );
    }
  }

  /**
   * Update product price
   * PATCH /products/:id/price
   * Roles: OWNER, MANAGER
   */
  @Patch(':id/price')
  @Roles('OWNER', 'MANAGER')
  async updatePrice(
    @Param('id') id: string,
    @Body() body: UpdatePriceDto,
    @Req() req: any,
  ) {
    try {
      if (body.sellingPrice === undefined || body.sellingPrice === null) {
        throw new HttpException(
          { success: false, message: 'Selling price is required' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const locationId = body.locationId || req.currentLocation?.locationId;
      if (!locationId) {
        throw new HttpException(
          { success: false, message: 'Location ID is required' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const input: UpdatePriceInput = {
        productId: id,
        sellingPrice: body.sellingPrice,
        locationId,
        syncToSquare: body.syncToSquare !== false,
        applyToAllLocations: body.applyToAllLocations === true,
      };

      const result = await this.productsService.updatePrice(input);

      return {
        success: true,
        message: result.message,
        data: {
          product: result.product,
          previousPrice: result.previousPrice,
          newPrice: result.newPrice,
          squareSynced: result.squareSynced,
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: getErrorMessage(error),
        },
        getErrorStatus(error),
      );
    }
  }
}
