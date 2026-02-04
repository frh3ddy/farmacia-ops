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
} from '@nestjs/common';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { AdjustmentType } from '@prisma/client';
import { AuthGuard, RoleGuard, LocationGuard, Roles, Public } from '../auth/guards/auth.guard';

// ============================================================================
// DTOs
// ============================================================================

interface CreateAdjustmentDto {
  locationId: string;
  productId: string;
  type: AdjustmentType;
  quantity: number;
  reason?: string;
  notes?: string;
  unitCost?: number;
  effectiveDate?: string;
  adjustedBy?: string;
  syncToSquare?: boolean; // If true, also update Square inventory
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

@Controller('inventory/adjustments')
@UseGuards(AuthGuard, RoleGuard, LocationGuard)
export class InventoryAdjustmentController {
  constructor(private readonly adjustmentService: InventoryAdjustmentService) {}

  // --------------------------------------------------------------------------
  // Create adjustment - OWNER, MANAGER only
  // --------------------------------------------------------------------------
  @Post()
  @Roles('OWNER', 'MANAGER')
  async createAdjustment(@Body() body: CreateAdjustmentDto, @Req() req: any) {
    try {
      const currentEmployee = req.employee;
      const currentLocation = req.currentLocation;

      // Use current location if not specified
      const locationId = body.locationId || currentLocation.locationId;

      // Validate required fields
      if (!body.productId || !body.type || body.quantity === undefined) {
        throw new HttpException(
          { success: false, message: 'Missing required fields: productId, type, quantity' },
          HttpStatus.BAD_REQUEST
        );
      }

      // Validate adjustment type
      const validTypes = Object.values(AdjustmentType);
      if (!validTypes.includes(body.type)) {
        throw new HttpException(
          { success: false, message: `Invalid adjustment type. Must be one of: ${validTypes.join(', ')}` },
          HttpStatus.BAD_REQUEST
        );
      }

      // Validate quantity is non-zero
      if (body.quantity === 0) {
        throw new HttpException(
          { success: false, message: 'Quantity cannot be zero' },
          HttpStatus.BAD_REQUEST
        );
      }

      // Parse effective date if provided
      let effectiveDate: Date | undefined;
      if (body.effectiveDate) {
        effectiveDate = parseDateString(body.effectiveDate);
        if (isNaN(effectiveDate.getTime())) {
          throw new HttpException(
            { success: false, message: 'Invalid effectiveDate format' },
            HttpStatus.BAD_REQUEST
          );
        }
      }

      const result = await this.adjustmentService.createAdjustment({
        locationId,
        productId: body.productId,
        type: body.type,
        quantity: body.quantity,
        reason: body.reason,
        notes: body.notes,
        unitCost: body.unitCost,
        effectiveDate,
        adjustedBy: currentEmployee.id,
        syncToSquare: body.syncToSquare,
      });

      // Build response message
      let message = `Adjustment created successfully: ${body.type} ${Math.abs(body.quantity)} units`;
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
          message: getErrorMessage(error) || 'Failed to create adjustment',
        },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Quick adjustment endpoints (convenience methods) - OWNER, MANAGER only
  // --------------------------------------------------------------------------
  @Post('damage')
  @Roles('OWNER', 'MANAGER')
  async recordDamage(@Body() body: Omit<CreateAdjustmentDto, 'type'>, @Req() req: any) {
    return this.createAdjustment({
      ...body,
      type: AdjustmentType.DAMAGE,
      quantity: -Math.abs(body.quantity), // Always negative
    }, req);
  }

  @Post('theft')
  @Roles('OWNER', 'MANAGER')
  async recordTheft(@Body() body: Omit<CreateAdjustmentDto, 'type'>, @Req() req: any) {
    return this.createAdjustment({
      ...body,
      type: AdjustmentType.THEFT,
      quantity: -Math.abs(body.quantity), // Always negative
    }, req);
  }

  @Post('expired')
  @Roles('OWNER', 'MANAGER')
  async recordExpired(@Body() body: Omit<CreateAdjustmentDto, 'type'>, @Req() req: any) {
    return this.createAdjustment({
      ...body,
      type: AdjustmentType.EXPIRED,
      quantity: -Math.abs(body.quantity), // Always negative
    }, req);
  }

  @Post('found')
  @Roles('OWNER', 'MANAGER')
  async recordFound(@Body() body: Omit<CreateAdjustmentDto, 'type'>, @Req() req: any) {
    return this.createAdjustment({
      ...body,
      type: AdjustmentType.FOUND,
      quantity: Math.abs(body.quantity), // Always positive
    }, req);
  }

  @Post('return')
  @Roles('OWNER', 'MANAGER')
  async recordReturn(@Body() body: Omit<CreateAdjustmentDto, 'type'>, @Req() req: any) {
    return this.createAdjustment({
      ...body,
      type: AdjustmentType.RETURN,
      quantity: Math.abs(body.quantity), // Always positive
    }, req);
  }

  @Post('count-correction')
  @Roles('OWNER', 'MANAGER')
  async recordCountCorrection(@Body() body: Omit<CreateAdjustmentDto, 'type'>, @Req() req: any) {
    return this.createAdjustment({
      ...body,
      type: AdjustmentType.COUNT_CORRECTION,
      // Keep original sign - can be positive or negative
    }, req);
  }

  @Post('write-off')
  @Roles('OWNER', 'MANAGER')
  async recordWriteOff(@Body() body: Omit<CreateAdjustmentDto, 'type'>, @Req() req: any) {
    return this.createAdjustment({
      ...body,
      type: AdjustmentType.WRITE_OFF,
      quantity: -Math.abs(body.quantity), // Always negative
    }, req);
  }

  // --------------------------------------------------------------------------
  // Query endpoints - OWNER, MANAGER can view all adjustments
  // --------------------------------------------------------------------------
  @Get(':id')
  @Roles('OWNER', 'MANAGER')
  async getAdjustment(@Param('id') id: string) {
    try {
      const adjustment = await this.adjustmentService.getAdjustment(id);
      return {
        success: true,
        data: {
          ...adjustment,
          unitCost: adjustment.unitCost.toString(),
          totalCost: adjustment.totalCost.toString(),
          consumptions: adjustment.consumptions.map(c => ({
            ...c,
            unitCost: c.unitCost.toString(),
            totalCost: c.totalCost.toString(),
          })),
          createdBatch: adjustment.createdBatch
            ? {
                ...adjustment.createdBatch,
                unitCost: adjustment.createdBatch.unitCost.toString(),
              }
            : null,
        },
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) || 'Failed to get adjustment' },
        getErrorStatus(error)
      );
    }
  }

  @Get('product/:productId')
  @Roles('OWNER', 'MANAGER')
  async getAdjustmentsByProduct(
    @Param('productId') productId: string,
    @Query('locationId') locationId?: string
  ) {
    try {
      const adjustments = await this.adjustmentService.getAdjustmentsByProduct(productId, locationId);
      return {
        success: true,
        count: adjustments.length,
        data: adjustments.map(a => ({
          ...a,
          unitCost: a.unitCost.toString(),
          totalCost: a.totalCost.toString(),
          consumptions: a.consumptions.map(c => ({
            ...c,
            unitCost: c.unitCost.toString(),
          })),
        })),
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) || 'Failed to get adjustments' },
        getErrorStatus(error)
      );
    }
  }

  @Get('location/:locationId')
  @Roles('OWNER', 'MANAGER')
  async getAdjustmentsByLocation(
    @Param('locationId') locationId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('type') type?: AdjustmentType,
    @Query('limit') limit?: string
  ) {
    try {
      const adjustments = await this.adjustmentService.getAdjustmentsByLocation(locationId, {
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        type,
        limit: limit ? parseInt(limit, 10) : undefined,
      });
      return {
        success: true,
        count: adjustments.length,
        data: adjustments.map(a => ({
          ...a,
          unitCost: a.unitCost.toString(),
          totalCost: a.totalCost.toString(),
          consumptions: a.consumptions.map(c => ({
            ...c,
            unitCost: c.unitCost.toString(),
          })),
        })),
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) || 'Failed to get adjustments' },
        getErrorStatus(error)
      );
    }
  }

  @Get('location/:locationId/summary')
  @Roles('OWNER', 'MANAGER')
  async getAdjustmentSummary(
    @Param('locationId') locationId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    try {
      const summary = await this.adjustmentService.getAdjustmentSummary(
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
  // Utility endpoints - Public
  // --------------------------------------------------------------------------
  @Get('types/list')
  @Public()
  getAdjustmentTypes() {
    const types = Object.values(AdjustmentType).map(type => ({
      value: type,
      label: type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase()),
      isPositive: ['FOUND', 'RETURN', 'TRANSFER_IN'].includes(type),
      isNegative: ['DAMAGE', 'THEFT', 'EXPIRED', 'TRANSFER_OUT', 'WRITE_OFF'].includes(type),
      isVariable: ['COUNT_CORRECTION', 'OTHER'].includes(type),
    }));

    return {
      success: true,
      data: types,
    };
  }
}
