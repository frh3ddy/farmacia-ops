import { Controller, Post, Get, Body, Param, Query, Req, UseGuards, HttpException, HttpStatus } from '@nestjs/common';
import { TransferStatus } from '@prisma/client';
import { TransferService } from './transfer.service';
import { AuthGuard, LocationGuard, Roles, scopedLocationId, assertLocationAccess, GuardedRequest, RoleGuardedRequest } from '../auth/guards/auth.guard';

interface ShipTransferDto {
  productId: string;
  fromLocationId?: string;
  toLocationId: string;
  quantity: number;
  reason?: string;
  notes?: string;
}

interface ReceiveTransferDto {
  lineReceipts?: { transferLineId: string; quantityReceived: number }[];
  syncToSquare?: boolean;
}

@Controller('transfers')
@UseGuards(AuthGuard, LocationGuard)
export class TransferController {
  constructor(private readonly transferService: TransferService) {}

  /**
   * Create + ship a transfer in one call. OWNER/MANAGER only.
   * POST /transfers
   */
  @Post()
  @Roles('OWNER', 'MANAGER')
  async ship(@Body() body: ShipTransferDto, @Req() req: GuardedRequest) {
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
    // LocationGuard only reads `locationId`; shipping out needs access to the source.
    assertLocationAccess(req, fromLocationId);

    const result = await this.transferService.ship({
      productId: body.productId,
      fromLocationId,
      toLocationId: body.toLocationId,
      quantity: body.quantity,
      reason: body.reason,
      notes: body.notes,
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
  async receive(@Param('id') id: string, @Body() body: ReceiveTransferDto, @Req() req: GuardedRequest) {
    const currentEmployee = req.employee;
    const result = await this.transferService.receive({
      transferId: id,
      lineReceipts: body.lineReceipts,
      syncToSquare: body.syncToSquare ?? true,
      receivedBy: currentEmployee?.id,
      assertAccess: (toLocationId) => assertLocationAccess(req, toLocationId),
    });

    return { success: true, message: `Received ${result.totalReceived} unit(s)`, data: result };
  }

  /**
   * Resend a received transfer whose Square sync failed. OWNER only.
   * POST /transfers/:id/retry-square-sync
   */
  @Post(':id/retry-square-sync')
  @Roles('OWNER')
  async retrySquareSync(@Param('id') id: string) {
    const result = await this.transferService.retrySquareSync(id);
    return {
      success: result.synced,
      message: result.synced ? 'Successfully synced to Square' : `Square sync failed: ${result.error}`,
      data: result,
    };
  }

  /**
   * List transfers. Non-owners are pinned to their own location (either
   * side of the transfer); owners can pass any locationId or omit it for all.
   * GET /transfers?locationId=&status=
   */
  @Get()
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async getTransfers(@Query('locationId') locationId: string, @Query('status') status: string, @Req() req: RoleGuardedRequest) {
    if (status && !Object.values<string>(TransferStatus).includes(status)) {
      throw new HttpException(
        { success: false, message: `Invalid status. Must be one of: ${Object.keys(TransferStatus).join(', ')}` },
        HttpStatus.BAD_REQUEST,
      );
    }
    const targetLocationId = scopedLocationId(req, locationId);

    const transfers = await this.transferService.getTransfers({
      locationId: targetLocationId || undefined,
      status: (status as TransferStatus) || undefined,
    });

    return { success: true, data: transfers };
  }
}
