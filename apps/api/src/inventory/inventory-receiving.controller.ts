import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { InventoryReceivingService } from './inventory-receiving.service';

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
}

// ============================================================================
// Controller
// ============================================================================

@Controller('inventory/receive')
export class InventoryReceivingController {
  constructor(private readonly receivingService: InventoryReceivingService) {}

  // --------------------------------------------------------------------------
  // Receive inventory
  // --------------------------------------------------------------------------
  @Post()
  async receiveInventory(@Body() body: ReceiveInventoryDto) {
    try {
      // Validate required fields
      if (!body.locationId || !body.productId || !body.quantity || body.unitCost === undefined) {
        throw new HttpException(
          { success: false, message: 'Missing required fields: locationId, productId, quantity, unitCost' },
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
        expiryDate = new Date(body.expiryDate);
        if (isNaN(expiryDate.getTime())) {
          throw new HttpException(
            { success: false, message: 'Invalid expiryDate format' },
            HttpStatus.BAD_REQUEST
          );
        }
      }

      if (body.manufacturingDate) {
        manufacturingDate = new Date(body.manufacturingDate);
        if (isNaN(manufacturingDate.getTime())) {
          throw new HttpException(
            { success: false, message: 'Invalid manufacturingDate format' },
            HttpStatus.BAD_REQUEST
          );
        }
      }

      const result = await this.receivingService.receiveInventory({
        locationId: body.locationId,
        productId: body.productId,
        quantity: body.quantity,
        unitCost: body.unitCost,
        supplierId: body.supplierId,
        invoiceNumber: body.invoiceNumber,
        purchaseOrderId: body.purchaseOrderId,
        batchNumber: body.batchNumber,
        expiryDate,
        manufacturingDate,
        receivedBy: body.receivedBy,
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

      return {
        success: true,
        message,
        data: result,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: error.message || 'Failed to receive inventory',
          error: error.name,
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  // --------------------------------------------------------------------------
  // Query endpoints
  // --------------------------------------------------------------------------
  @Get(':id')
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
        { success: false, message: error.message || 'Failed to get receiving' },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get('location/:locationId')
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
        { success: false, message: error.message || 'Failed to get receivings' },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get('product/:productId')
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
        { success: false, message: error.message || 'Failed to get receivings' },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get('location/:locationId/summary')
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
        { success: false, message: error.message || 'Failed to get summary' },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  // --------------------------------------------------------------------------
  // Retry Square sync
  // --------------------------------------------------------------------------
  @Post(':id/retry-square-sync')
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
        { success: false, message: error.message || 'Failed to retry sync' },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}
