import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Req,
  HttpException,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { InventoryReceivingService } from './inventory-receiving.service';
import { ProductsService } from '../products/products.service';
import { AuthGuard, RoleGuard, LocationGuard, Roles } from '../auth/guards/auth.guard';

// ============================================================================
// DTOs
// ============================================================================

interface ReceiveInventoryDto {
  locationId: string;
  productId: string;
  quantity: number;
  unitCost: number;
  supplierId?: string;
  invoiceNumber?: string;
  purchaseOrderId?: string;
  batchNumber?: string;
  expiryDate?: string;
  manufacturingDate?: string;
  receivedBy?: string;
  notes?: string;
  syncToSquare?: boolean;
  // Optional selling price update
  sellingPrice?: number;
  syncPriceToSquare?: boolean;
}

// Helper to extract error message
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getErrorStatus(error: unknown): number {
  if (error && typeof error === 'object' && 'status' in error) {
    return (error as { status: number }).status;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

/**
 * Parse a date string that could be either:
 * - Date-only: "2026-02-03" -> treated as local date (noon to avoid timezone edge cases)
 * - Full ISO: "2026-02-03T12:00:00Z" -> parsed as-is
 */
function parseDateString(dateStr: string): Date {
  // If it's a date-only string (YYYY-MM-DD), add noon time to avoid timezone issues
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    // Parse as local date at noon to avoid any timezone day-shift issues
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0);
  }
  // Otherwise parse as full ISO date
  return new Date(dateStr);
}

// ============================================================================
// Controller
// ============================================================================

@Controller('inventory/receive')
@UseGuards(AuthGuard, RoleGuard, LocationGuard)
export class InventoryReceivingController {
  private readonly logger = new Logger(InventoryReceivingController.name);
  
  constructor(
    private readonly receivingService: InventoryReceivingService,
    private readonly productsService: ProductsService,
  ) {}

  // --------------------------------------------------------------------------
  // Receive inventory - OWNER, MANAGER only
  // --------------------------------------------------------------------------
  @Post()
  @Roles('OWNER', 'MANAGER')
  async receiveInventory(@Body() body: ReceiveInventoryDto, @Req() req: any) {
    try {
      const currentEmployee = req.employee;
      const currentLocation = req.currentLocation;

      // Use current location if not specified
      const locationId = body.locationId || currentLocation.locationId;

      // Validate required fields
      if (!body.productId || !body.quantity || body.unitCost === undefined) {
        throw new HttpException(
          { success: false, message: 'Missing required fields: productId, quantity, unitCost' },
          HttpStatus.BAD_REQUEST
        );
      }

      // Validate quantity
      if (body.quantity <= 0) {
        throw new HttpException(
          { success: false, message: 'Quantity must be a positive number' },
          HttpStatus.BAD_REQUEST
        );
      }

      // Validate unit cost
      if (body.unitCost < 0) {
        throw new HttpException(
          { success: false, message: 'Unit cost cannot be negative' },
          HttpStatus.BAD_REQUEST
        );
      }

      // Parse dates
      let expiryDate: Date | undefined;
      let manufacturingDate: Date | undefined;

      if (body.expiryDate) {
        expiryDate = parseDateString(body.expiryDate);
        if (isNaN(expiryDate.getTime())) {
          throw new HttpException(
            { success: false, message: 'Invalid expiryDate format' },
            HttpStatus.BAD_REQUEST
          );
        }
      }

      if (body.manufacturingDate) {
        manufacturingDate = parseDateString(body.manufacturingDate);
        if (isNaN(manufacturingDate.getTime())) {
          throw new HttpException(
            { success: false, message: 'Invalid manufacturingDate format' },
            HttpStatus.BAD_REQUEST
          );
        }
      }

      const result = await this.receivingService.receiveInventory({
        locationId,
        productId: body.productId,
        quantity: body.quantity,
        unitCost: body.unitCost,
        supplierId: body.supplierId,
        invoiceNumber: body.invoiceNumber,
        purchaseOrderId: body.purchaseOrderId,
        batchNumber: body.batchNumber,
        expiryDate,
        manufacturingDate,
        receivedBy: currentEmployee.id,
        notes: body.notes,
        syncToSquare: body.syncToSquare,
      });

      // Build response message
      let message = `Received ${body.quantity} units successfully`;
      if (result.squareSync) {
        message += result.squareSync.synced
          ? ' (synced to Square)'
          : ` (Square sync failed: ${result.squareSync.error})`;
      }

      // Update selling price if provided
      let priceUpdate = null;
      if (body.sellingPrice !== undefined && body.sellingPrice > 0) {
        try {
          const priceResult = await this.productsService.updatePrice({
            productId: body.productId,
            sellingPrice: body.sellingPrice,
            locationId,
            syncToSquare: body.syncPriceToSquare !== false, // Default true
          });
          priceUpdate = {
            previousPrice: priceResult.previousPrice,
            newPrice: priceResult.newPrice,
            squareSynced: priceResult.squareSynced,
          };
          message += priceResult.squareSynced 
            ? ` | Price updated to $${body.sellingPrice} MXN (synced to Square)`
            : ` | Price updated to $${body.sellingPrice} MXN locally`;
          this.logger.log(`[RECEIVING] Price updated for product ${body.productId}: $${body.sellingPrice} MXN`);
        } catch (priceError) {
          this.logger.error(`[RECEIVING] Failed to update price: ${priceError}`);
          message += ` | Price update failed: ${getErrorMessage(priceError)}`;
          priceUpdate = { error: getErrorMessage(priceError) };
        }
      }

      return {
        success: true,
        message,
        data: {
          ...result,
          priceUpdate,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: getErrorMessage(error) || 'Failed to receive inventory',
        },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Query endpoints - OWNER, MANAGER can view receivings
  // --------------------------------------------------------------------------
  @Get(':id')
  @Roles('OWNER', 'MANAGER')
  async getReceiving(@Param('id') id: string) {
    try {
      const receiving = await this.receivingService.getReceiving(id);
      return {
        success: true,
        data: {
          ...receiving,
          unitCost: receiving.unitCost.toString(),
          totalCost: receiving.totalCost.toString(),
          inventoryBatch: receiving.inventoryBatch
            ? {
                ...receiving.inventoryBatch,
                unitCost: receiving.inventoryBatch.unitCost.toString(),
              }
            : null,
        },
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) || 'Failed to get receiving' },
        getErrorStatus(error)
      );
    }
  }

  @Get('location/:locationId')
  @Roles('OWNER', 'MANAGER')
  async getReceivingsByLocation(
    @Param('locationId') locationId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('supplierId') supplierId?: string,
    @Query('productId') productId?: string,
    @Query('limit') limit?: string
  ) {
    try {
      const receivings = await this.receivingService.getReceivingsByLocation(locationId, {
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        supplierId,
        productId,
        limit: limit ? parseInt(limit, 10) : undefined,
      });
      return {
        success: true,
        count: receivings.length,
        data: receivings.map(r => ({
          ...r,
          unitCost: r.unitCost.toString(),
          totalCost: r.totalCost.toString(),
        })),
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) || 'Failed to get receivings' },
        getErrorStatus(error)
      );
    }
  }

  @Get('product/:productId')
  @Roles('OWNER', 'MANAGER')
  async getReceivingsByProduct(
    @Param('productId') productId: string,
    @Query('locationId') locationId?: string
  ) {
    try {
      const receivings = await this.receivingService.getReceivingsByProduct(productId, locationId);
      return {
        success: true,
        count: receivings.length,
        data: receivings.map(r => ({
          ...r,
          unitCost: r.unitCost.toString(),
          totalCost: r.totalCost.toString(),
        })),
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) || 'Failed to get receivings' },
        getErrorStatus(error)
      );
    }
  }

  @Get('location/:locationId/summary')
  @Roles('OWNER', 'MANAGER')
  async getReceivingSummary(
    @Param('locationId') locationId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    try {
      const summary = await this.receivingService.getReceivingSummary(
        locationId,
        startDate ? new Date(startDate) : undefined,
        endDate ? new Date(endDate) : undefined
      );
      return {
        success: true,
        data: summary,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) || 'Failed to get summary' },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Retry Square sync - OWNER only
  // --------------------------------------------------------------------------
  @Post(':id/retry-square-sync')
  @Roles('OWNER')
  async retrySquareSync(@Param('id') id: string) {
    try {
      const result = await this.receivingService.retrySquareSync(id);
      return {
        success: result.synced,
        message: result.synced
          ? 'Successfully synced to Square'
          : `Square sync failed: ${result.error}`,
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) || 'Failed to retry sync' },
        getErrorStatus(error)
      );
    }
  }
}
