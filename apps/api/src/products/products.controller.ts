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
  constructor(private readonly productsService: ProductsService) {}

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
   * Get single product
   * GET /products/:id
   * Roles: All authenticated users
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
