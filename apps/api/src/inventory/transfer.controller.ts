import { Controller, Post, Get, Body, Param, Query, Req, UseGuards, HttpException, HttpStatus, ForbiddenException } from '@nestjs/common';
import { TransferStatus } from '@prisma/client';
import { TransferService, ShipmentStatus } from './transfer.service';
import { AuthGuard, LocationGuard, Roles, scopedLocationId, assertLocationAccess, GuardedRequest, RoleGuardedRequest } from '../auth/guards/auth.guard';
import { readableSync, squareSyncReason } from '../square/square-sync-reason';

interface ShipTransferDto {
  productId: string;
  fromLocationId?: string;
  toLocationId: string;
  quantity: number;
  reason?: string;
  notes?: string;
}

interface ShipBatchDto {
  toLocationId: string;
  clientRequestId: string;
  /** Received in the same step it is sent; required. */
  receiveOnSend: boolean;
  items: { productId: string; quantity: number }[];
}

interface ReceiveShipmentDto {
  lines?: { transferLineId: string; quantityReceived: number }[];
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
   * Send several products from the session's store in one go, all or nothing.
   * Receiving on send needs access to the destination too (OWNER: any).
   * POST /transfers/batch
   */
  @Post('batch')
  @Roles('OWNER', 'MANAGER')
  async shipBatch(@Body() body: ShipBatchDto, @Req() req: GuardedRequest) {
    const fromLocationId = req.currentLocation?.locationId;
    if (!fromLocationId) throw new HttpException({ success: false, message: 'fromLocationId is required' }, HttpStatus.BAD_REQUEST);
    if (!body.toLocationId) throw new HttpException({ success: false, message: 'toLocationId is required' }, HttpStatus.BAD_REQUEST);
    assertLocationAccess(req, fromLocationId);
    if (typeof body.receiveOnSend !== 'boolean') {
      throw new HttpException({ success: false, message: 'receiveOnSend must be true or false' }, HttpStatus.BAD_REQUEST);
    }
    const receiveOnSend = body.receiveOnSend;
    if (receiveOnSend) {
      try {
        assertLocationAccess(req, body.toLocationId);
      } catch {
        throw new ForbiddenException({
          success: false,
          code: 'RECEIVE_ON_SEND_NOT_ALLOWED',
          message: 'No tienes acceso a la sucursal de destino: envíala para confirmar al llegar',
        });
      }
    }

    const data = await this.transferService.shipBatch({
      fromLocationId,
      toLocationId: body.toLocationId,
      clientRequestId: body.clientRequestId,
      receiveOnSend,
      items: body.items,
      createdBy: req.employee?.id,
    });
    return { success: true, data };
  }

  /**
   * Shipments to or from a store, newest first. Scoped like GET /transfers.
   * GET /transfers/shipments?locationId=&status=IN_TRANSIT|RECEIVED
   */
  @Get('shipments')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async getShipments(@Query('locationId') locationId: string, @Query('status') status: string, @Req() req: RoleGuardedRequest) {
    if (status && status !== 'IN_TRANSIT' && status !== 'RECEIVED') {
      throw new HttpException({ success: false, message: 'Invalid status. Must be one of: IN_TRANSIT, RECEIVED' }, HttpStatus.BAD_REQUEST);
    }
    const data = await this.transferService.getShipments({
      locationId: scopedLocationId(req, locationId) || undefined,
      status: (status as ShipmentStatus) || undefined,
    });
    return { success: true, data };
  }

  /**
   * Receive every product of a shipment still in transit; a line not listed
   * arrives at its sent quantity.
   * POST /transfers/shipments/:id/receive
   */
  @Post('shipments/:id/receive')
  @Roles('OWNER', 'MANAGER')
  async receiveShipment(@Param('id') id: string, @Body() body: ReceiveShipmentDto, @Req() req: GuardedRequest) {
    const data = await this.transferService.receiveShipment({
      shipmentId: id,
      lineReceipts: body.lines,
      receivedBy: req.employee?.id,
      assertAccess: (toLocationId) => assertLocationAccess(req, toLocationId),
    });
    return { success: true, data };
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
      message: result.synced ? 'Sincronizado con Square' : `No se sincronizó con Square: ${squareSyncReason(result.error)}`,
      data: readableSync(result),
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
