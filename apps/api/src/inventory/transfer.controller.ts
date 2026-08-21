import { Controller, Post, Get, Body, Param, Query, Req, UseGuards, HttpException, HttpStatus } from '@nestjs/common';
import { TransferService } from './transfer.service';
import { AuthGuard, RoleGuard, LocationGuard, Roles } from '../auth/guards/auth.guard';

interface ShipTransferDto {
  productId: string;
  fromLocationId?: string;
  toLocationId: string;
  quantity: number;
  reason?: string;
  notes?: string;
  syncToSquare?: boolean;
}

interface ReceiveTransferDto {
  lineReceipts?: { transferLineId: string; quantityReceived: number }[];
  syncToSquare?: boolean;
}

@Controller('transfers')
@UseGuards(AuthGuard, RoleGuard, LocationGuard)
export class TransferController {
  constructor(private readonly transferService: TransferService) {}

  /**
   * Create + ship a transfer in one call. OWNER/MANAGER only.
   * POST /transfers
   */
  @Post()
  @Roles('OWNER', 'MANAGER')
  async ship(@Body() body: ShipTransferDto, @Req() req: any) {
    const currentLocation = req.currentLocation;
    const currentEmployee = req.employee;
    const fromLocationId = body.fromLocationId || currentLocation?.locationId;

    if (!body.productId || !body.toLocationId || body.quantity === undefined) {
      throw new HttpException(
        { success: false, message: 'Missing required fields: productId, toLocationId, quantity' },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!fromLocationId) {
      throw new HttpException({ success: false, message: 'fromLocationId is required' }, HttpStatus.BAD_REQUEST);
    }

    const result = await this.transferService.ship({
      productId: body.productId,
      fromLocationId,
      toLocationId: body.toLocationId,
      quantity: body.quantity,
      reason: body.reason,
      notes: body.notes,
      syncToSquare: body.syncToSquare ?? true,
      createdBy: currentEmployee?.id,
    });

    return { success: true, message: `Shipped ${body.quantity} unit(s)`, data: result };
  }

  /**
   * Receive an in-transit transfer, optionally with per-line partial quantities.
   * POST /transfers/:id/receive
   */
  @Post(':id/receive')
  @Roles('OWNER', 'MANAGER')
  async receive(@Param('id') id: string, @Body() body: ReceiveTransferDto, @Req() req: any) {
    const currentEmployee = req.employee;
    const result = await this.transferService.receive({
      transferId: id,
      lineReceipts: body.lineReceipts,
      syncToSquare: body.syncToSquare ?? true,
      receivedBy: currentEmployee?.id,
    });

    return { success: true, message: `Received ${result.totalReceived} unit(s)`, data: result };
  }

  /**
   * List transfers. Non-owners are pinned to their own location (either
   * side of the transfer); owners can pass any locationId or omit it for all.
   * GET /transfers?locationId=&status=
   */
  @Get()
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async getTransfers(@Query('locationId') locationId: string, @Query('status') status: string, @Req() req: any) {
    const currentLocation = req.currentLocation;
    const targetLocationId = currentLocation.role === 'OWNER' ? locationId : currentLocation.locationId;

    const transfers = await this.transferService.getTransfers({
      locationId: targetLocationId || undefined,
      status: status || undefined,
    });

    return { success: true, data: transfers };
  }
}
