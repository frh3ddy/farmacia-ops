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
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
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

// Multer memory storage — files are never written to disk.
// The buffer is sent directly to Square and the Square-hosted URL is stored.
const productImageMemoryStorage = memoryStorage();

const imageFileFilter = (_req: any, file: any, cb: any) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new HttpException('Only image files are allowed', HttpStatus.BAD_REQUEST), false);
  }
};

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
   * Get products (supports pagination)
   * GET /products
   * Roles: All authenticated users
   *
   * Query params:
   *   locationId  - target location (falls back to current)
   *   page        - 1-based page number (default 1)
   *   limit       - items per page (default 50, max 200)
   *   search      - optional name/SKU search term
   *
   * Response shape:
   *   { success, data, count, page, limit, totalCount, totalPages, hasMore }
   */
  @Get()
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async getProducts(
    @Query('locationId') locationId: string,
    @Query('page') pageStr: string,
    @Query('limit') limitStr: string,
    @Query('search') search: string,
    @Req() req: any,
  ) {
    try {
      // Use query param or current location
      const targetLocationId = locationId || req.currentLocation?.locationId;

      // Parse pagination params with sensible defaults
      const page = Math.max(1, parseInt(pageStr, 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(limitStr, 10) || 50));

      const result = await this.productsService.getProducts(targetLocationId, {
        page,
        limit,
        search: search?.trim() || undefined,
      });
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
   * Upload or replace product image
   * POST /products/:id/image
   * Roles: OWNER, MANAGER
   * Accepts multipart/form-data with an "image" field
   */
  @Post(':id/image')
  @Roles('OWNER', 'MANAGER')
  @UseInterceptors(
    FileInterceptor('image', {
      storage: productImageMemoryStorage,
      fileFilter: imageFileFilter,
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    }),
  )
  async uploadProductImage(
    @Param('id') productId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    try {
      if (!file || !file.buffer) {
        throw new HttpException(
          { success: false, message: 'No image file provided' },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Send the in-memory buffer directly to Square — no disk writes
      const result = await this.productsService.uploadProductImage(
        productId,
        file.buffer,
        file.mimetype,
      );

      return {
        success: true,
        imageUrl: result.imageUrl,
        squareSynced: result.squareSynced,
        squareImageId: result.squareImageId,
        message: result.message,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: `Failed to upload image: ${getErrorMessage(error)}` },
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
