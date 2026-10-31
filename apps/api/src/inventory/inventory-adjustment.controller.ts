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
import { AuthGuard, LocationGuard, Roles, scopedLocationId, assertLocationAccess, GuardedRequest, RoleGuardedRequest } from '../auth/guards/auth.guard';
import { USER_ADJUSTMENT_TYPES } from './adjustment-types';
import { parseDateParam } from './business-date';
import { readableSync, squareSyncNote, squareSyncReason } from '../square/square-sync-reason';

/** Adjustment types as staff call them, for messages. */
const ADJUSTMENT_LABELS: Partial<Record<AdjustmentType, string>> = {
  DAMAGE: 'Daño',
  THEFT: 'Robo',
  EXPIRED: 'Vencido',
  COUNT_CORRECTION: 'Corrección de conteo',
  FOUND: 'Encontrado',
  RETURN: 'Devolución',
  WRITE_OFF: 'Baja',
  OTHER: 'Otro',
};

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
  syncToSquare?: boolean; // If true, also update Square inventory
  clientRequestId?: string; // Dedup key for offline-queue replay (iOS)
  countedQuantity?: number; // COUNT_CORRECTION only: the shelf total; the server derives the change
}

// ============================================================================
// Controller
// ============================================================================

@Controller('inventory/adjustments')
@UseGuards(AuthGuard, LocationGuard)
export class InventoryAdjustmentController {
  constructor(private readonly adjustmentService: InventoryAdjustmentService) {}

  // --------------------------------------------------------------------------
  // Create adjustment - OWNER, MANAGER only
  // --------------------------------------------------------------------------
  @Post()
  @Roles('OWNER', 'MANAGER')
  async createAdjustment(@Body() body: CreateAdjustmentDto, @Req() req: RoleGuardedRequest) {
    const currentEmployee = req.employee;
    const currentLocation = req.currentLocation;

    const locationId = body.locationId || currentLocation.locationId;

    const counted = body.type === AdjustmentType.COUNT_CORRECTION && body.countedQuantity != null;
    if (!body.productId || !body.type || (body.quantity === undefined && !counted)) {
      throw new HttpException(
        { success: false, message: 'Missing required fields: productId, type, quantity' },
        HttpStatus.BAD_REQUEST
      );
    }

    if (!USER_ADJUSTMENT_TYPES.includes(body.type)) {
      throw new HttpException(
        { success: false, message: `Invalid adjustment type. Must be one of: ${USER_ADJUSTMENT_TYPES.join(', ')}` },
        HttpStatus.BAD_REQUEST
      );
    }

    const effectiveDate = parseDateParam(body.effectiveDate, 'effectiveDate');

    const common = {
      locationId,
      productId: body.productId,
      reason: body.reason,
      notes: body.notes,
      unitCost: body.unitCost,
      effectiveDate,
      adjustedBy: currentEmployee.id,
      syncToSquare: body.syncToSquare,
      clientRequestId: body.clientRequestId,
    };
    const result = await this.adjustmentService.createAdjustment(counted
      ? { ...common, type: AdjustmentType.COUNT_CORRECTION, countedQuantity: body.countedQuantity! }
      : { ...common, type: body.type, quantity: body.quantity });

    const units = Math.abs(counted ? result.adjustment.quantity : body.quantity);
    const type = ADJUSTMENT_LABELS[counted ? AdjustmentType.COUNT_CORRECTION : body.type] ?? body.type;
    const message = `Ajuste registrado: ${type}, ${units} unidades${squareSyncNote(result.squareSync)}`;

    return {
      success: true,
      message,
      data: { ...result, squareSync: result.squareSync && readableSync(result.squareSync) },
    };
  }

  // --------------------------------------------------------------------------
  // Quick adjustment endpoints (convenience methods) - OWNER, MANAGER only
  // --------------------------------------------------------------------------
  @Post('damage')
  @Roles('OWNER', 'MANAGER')
  async recordDamage(@Body() body: Omit<CreateAdjustmentDto, 'type'>, @Req() req: RoleGuardedRequest) {
    return this.createAdjustment({
      ...body,
      type: AdjustmentType.DAMAGE,
      quantity: -Math.abs(body.quantity), // Always negative
    }, req);
  }

  @Post('theft')
  @Roles('OWNER', 'MANAGER')
  async recordTheft(@Body() body: Omit<CreateAdjustmentDto, 'type'>, @Req() req: RoleGuardedRequest) {
    return this.createAdjustment({
      ...body,
      type: AdjustmentType.THEFT,
      quantity: -Math.abs(body.quantity), // Always negative
    }, req);
  }

  @Post('expired')
  @Roles('OWNER', 'MANAGER')
  async recordExpired(@Body() body: Omit<CreateAdjustmentDto, 'type'>, @Req() req: RoleGuardedRequest) {
    return this.createAdjustment({
      ...body,
      type: AdjustmentType.EXPIRED,
      quantity: -Math.abs(body.quantity), // Always negative
    }, req);
  }

  @Post('found')
  @Roles('OWNER', 'MANAGER')
  async recordFound(@Body() body: Omit<CreateAdjustmentDto, 'type'>, @Req() req: RoleGuardedRequest) {
    return this.createAdjustment({
      ...body,
      type: AdjustmentType.FOUND,
      quantity: Math.abs(body.quantity), // Always positive
    }, req);
  }

  @Post('return')
  @Roles('OWNER', 'MANAGER')
  async recordReturn(@Body() body: Omit<CreateAdjustmentDto, 'type'>, @Req() req: RoleGuardedRequest) {
    return this.createAdjustment({
      ...body,
      type: AdjustmentType.RETURN,
      quantity: Math.abs(body.quantity), // Always positive
    }, req);
  }

  @Post('count-correction')
  @Roles('OWNER', 'MANAGER')
  async recordCountCorrection(@Body() body: Omit<CreateAdjustmentDto, 'type'>, @Req() req: RoleGuardedRequest) {
    return this.createAdjustment({
      ...body,
      type: AdjustmentType.COUNT_CORRECTION,
      // Keep original sign - can be positive or negative
    }, req);
  }

  @Post('write-off')
  @Roles('OWNER', 'MANAGER')
  async recordWriteOff(@Body() body: Omit<CreateAdjustmentDto, 'type'>, @Req() req: RoleGuardedRequest) {
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
  async getAdjustment(@Param('id') id: string, @Req() req: GuardedRequest) {
    const adjustment = await this.adjustmentService.getAdjustment(id);
    // No locationId in the request for LocationGuard to check — check the record's.
    assertLocationAccess(req, adjustment.locationId);
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
  }

  @Get('product/:productId')
  @Roles('OWNER', 'MANAGER')
  async getAdjustmentsByProduct(
    @Req() req: GuardedRequest,
    @Param('productId') productId: string,
    @Query('locationId') locationId?: string
  ) {
    const adjustments = await this.adjustmentService.getAdjustmentsByProduct(productId, scopedLocationId(req, locationId));
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
    const adjustments = await this.adjustmentService.getAdjustmentsByLocation(locationId, {
      startDate: parseDateParam(startDate, 'startDate', 'start'),
      endDate: parseDateParam(endDate, 'endDate', 'end'),
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
  }

  // --------------------------------------------------------------------------
  // Retry Square sync - OWNER only
  // --------------------------------------------------------------------------
  @Post(':id/retry-square-sync')
  @Roles('OWNER')
  async retrySquareSync(@Param('id') id: string) {
    const result = await this.adjustmentService.retrySquareSync(id);
    return {
      success: result.synced,
      message: result.synced
        ? 'Sincronizado con Square'
        : `No se sincronizó con Square: ${squareSyncReason(result.error)}`,
      data: readableSync(result),
    };
  }
}
