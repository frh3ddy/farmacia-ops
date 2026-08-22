import { Controller, Post, Body, Req, UseGuards, HttpException, HttpStatus } from '@nestjs/common';
import { BreakBulkService } from './break-bulk.service';
import { AuthGuard, RoleGuard, LocationGuard, Roles } from '../auth/guards/auth.guard';

interface BreakBulkDto {
  boxProductId: string;
  locationId?: string;
  boxQuantity: number;
  reason?: string;
  notes?: string;
  syncToSquare?: boolean;
}

@Controller('inventory/break-bulk')
@UseGuards(AuthGuard, RoleGuard, LocationGuard)
export class BreakBulkController {
  constructor(private readonly breakBulkService: BreakBulkService) {}

  /**
   * Open N boxes of a product and add them as loose units of its linked
   * loose product. OWNER/MANAGER only — this moves real stock and cost basis.
   */
  @Post()
  @Roles('OWNER', 'MANAGER')
  async breakBulk(@Body() body: BreakBulkDto, @Req() req: any) {
    const currentLocation = req.currentLocation;
    const currentEmployee = req.employee;
    const locationId = body.locationId || currentLocation?.locationId;

    if (!body.boxProductId || body.boxQuantity === undefined) {
      throw new HttpException(
        { success: false, message: 'Missing required fields: boxProductId, boxQuantity' },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!locationId) {
      throw new HttpException({ success: false, message: 'Location ID is required' }, HttpStatus.BAD_REQUEST);
    }

    const result = await this.breakBulkService.breakBulk({
      boxProductId: body.boxProductId,
      locationId,
      boxQuantity: body.boxQuantity,
      reason: body.reason,
      notes: body.notes,
      syncToSquare: body.syncToSquare ?? true,
      adjustedBy: currentEmployee?.id,
    });

    return {
      success: true,
      message: `Broke ${body.boxQuantity} box(es) into ${result.looseUnitsCreated} loose units`,
      data: result,
    };
  }
}
