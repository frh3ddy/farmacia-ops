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
import { parseBusinessDate, parseDateParam } from './business-date';
import { ProductsService } from '../products/products.service';
import { AuthGuard, LocationGuard, Roles, scopedLocationId, assertLocationAccess, GuardedRequest, RoleGuardedRequest } from '../auth/guards/auth.guard';

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
  notes?: string;
  syncToSquare?: boolean;
  clientRequestId?: string; // Dedup key for offline-queue replay (iOS)
  // Optional selling price update
  sellingPrice?: number;
  syncPriceToSquare?: boolean;
}

// Helper to extract error message
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ============================================================================
// Controller
// ============================================================================

@Controller('inventory/receive')
@UseGuards(AuthGuard, LocationGuard)
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
  async receiveInventory(@Body() body: ReceiveInventoryDto, @Req() req: RoleGuardedRequest) {
    const currentEmployee = req.employee;
    const currentLocation = req.currentLocation;

    // Use current location if not specified
    const locationId = body.locationId || currentLocation.locationId;

    // Validate required fields
    // quantity and unitCost are checked by the service
    if (!body.productId) {
      throw new HttpException(
        { success: false, message: 'Missing required field: productId' },
        HttpStatus.BAD_REQUEST
      );
    }

    // Parse dates
    let expiryDate: Date | undefined;
    let manufacturingDate: Date | undefined;

    if (body.expiryDate) {
      expiryDate = parseBusinessDate(body.expiryDate);
      if (isNaN(expiryDate.getTime())) {
        throw new HttpException(
          { success: false, message: 'La fecha de caducidad no es válida' },
          HttpStatus.BAD_REQUEST
        );
      }
    }

    if (body.manufacturingDate) {
      manufacturingDate = parseBusinessDate(body.manufacturingDate);
      if (isNaN(manufacturingDate.getTime())) {
        throw new HttpException(
          { success: false, message: 'La fecha de fabricación no es válida' },
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
      clientRequestId: body.clientRequestId,
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
          ? ` | Price updated to $${body.sellingPrice} (synced to Square)`
          : ` | Price updated to $${body.sellingPrice} locally`;
        this.logger.log(`[RECEIVING] Price updated for product ${body.productId}: $${body.sellingPrice} (squareSynced: ${priceResult.squareSynced})`);
      } catch (priceError) {
        this.logger.error(`[RECEIVING] Failed to update price: ${priceError}`);
        message += ` | Price update failed: ${getErrorMessage(priceError)}`;
        priceUpdate = { error: getErrorMessage(priceError) };
      }
    }

    // Fetch the updated product so the client has fresh data in one round-trip
    let updatedProduct = null;
    try {
      const productResult = await this.productsService.getProduct(
        body.productId,
        locationId,
      );
      updatedProduct = productResult.data;
    } catch (productError) {
      this.logger.error(`[RECEIVING] Failed to fetch updated product: ${productError}`);
      // Non-fatal — the receiving itself succeeded
    }

    return {
      success: true,
      message,
      data: {
        ...result,
        priceUpdate,
        product: updatedProduct,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Query endpoints - OWNER, MANAGER can view receivings
  // --------------------------------------------------------------------------
  @Get(':id')
  @Roles('OWNER', 'MANAGER')
  async getReceiving(@Param('id') id: string, @Req() req: GuardedRequest) {
    const receiving = await this.receivingService.getReceiving(id);
    // No locationId in the request for LocationGuard to check — check the record's.
    assertLocationAccess(req, receiving.locationId);
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
    const receivings = await this.receivingService.getReceivingsByLocation(locationId, {
      startDate: parseDateParam(startDate, 'startDate', 'start'),
      endDate: parseDateParam(endDate, 'endDate', 'end'),
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
  }

  @Get('product/:productId')
  @Roles('OWNER', 'MANAGER')
  async getReceivingsByProduct(
    @Req() req: GuardedRequest,
    @Param('productId') productId: string,
    @Query('locationId') locationId?: string
  ) {
    const receivings = await this.receivingService.getReceivingsByProduct(productId, scopedLocationId(req, locationId));
    return {
      success: true,
      count: receivings.length,
      data: receivings.map(r => ({
        ...r,
        unitCost: r.unitCost.toString(),
        totalCost: r.totalCost.toString(),
      })),
    };
  }

  @Get('location/:locationId/summary')
  @Roles('OWNER', 'MANAGER')
  async getReceivingSummary(
    @Param('locationId') locationId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    const summary = await this.receivingService.getReceivingSummary(
      locationId,
      parseDateParam(startDate, 'startDate', 'start'),
      parseDateParam(endDate, 'endDate', 'end')
    );
    return {
      success: true,
      data: summary,
    };
  }

  // --------------------------------------------------------------------------
  // Retry Square sync - OWNER only
  // --------------------------------------------------------------------------
  @Post(':id/retry-square-sync')
  @Roles('OWNER')
  async retrySquareSync(@Param('id') id: string) {
    const result = await this.receivingService.retrySquareSync(id);
    return {
      success: result.synced,
      message: result.synced
        ? 'Successfully synced to Square'
        : `Square sync failed: ${result.error}`,
      data: result,
    };
  }
}
