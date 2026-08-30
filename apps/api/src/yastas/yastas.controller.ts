import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { YastasOperationDirection } from '@prisma/client';
import { YastasService } from './yastas.service';
import { AuthGuard, RoleGuard, LocationGuard, Roles } from '../auth/guards/auth.guard';

// ============================================================================
// DTOs
// ============================================================================

interface RecordOutOperationDto {
  locationId: string;
  faceAmount: number;
  yastasReceiptRef?: string;
}

interface SetOpeningBalanceDto {
  amount: number;
}

interface CreateWalletTransferDto {
  fromLocationId: string;
  toLocationId: string;
  amount: number;
}

interface CreateSettlementDto {
  locationId: string;
  periodStart: string;
  periodEnd: string;
  amountEarned: number;
  notes?: string;
}

interface UpdateSettlementDto {
  status?: 'PROVISIONAL' | 'CONFIRMED';
  reportedAt?: string;
  paidAt?: string;
}

// ============================================================================
// Controller
// ============================================================================

@Controller('yastas')
@UseGuards(AuthGuard, RoleGuard, LocationGuard)
export class YastasController {
  constructor(private readonly yastasService: YastasService) {}

  // --------------------------------------------------------------------------
  // Log an OUT operation (withdrawal) — any authenticated employee, PIN
  // session supplies employeeId. Never touches Square.
  // --------------------------------------------------------------------------
  @Post('operations/out')
  async recordOutOperation(@Body() body: RecordOutOperationDto, @Req() req: any) {
    const currentEmployee = req.employee;

    if (!body.locationId || body.faceAmount === undefined) {
      throw new HttpException(
        { success: false, message: 'Missing required fields: locationId, faceAmount' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.yastasService.recordOutOperation({
      locationId: body.locationId,
      employeeId: currentEmployee.id,
      faceAmount: body.faceAmount,
      yastasReceiptRef: body.yastasReceiptRef,
    });

    return { success: true, data: result };
  }

  // --------------------------------------------------------------------------
  // Wallet transfer between locations — OWNER, MANAGER, ACCOUNTANT only.
  // --------------------------------------------------------------------------
  @Post('wallet-transfers')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async createWalletTransfer(@Body() body: CreateWalletTransferDto, @Req() req: any) {
    const currentEmployee = req.employee;

    if (!body.fromLocationId || !body.toLocationId || body.amount === undefined) {
      throw new HttpException(
        { success: false, message: 'Missing required fields: fromLocationId, toLocationId, amount' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const transfer = await this.yastasService.createWalletTransfer({
      fromLocationId: body.fromLocationId,
      toLocationId: body.toLocationId,
      amount: body.amount,
      createdBy: currentEmployee.id,
    });

    return { success: true, data: transfer };
  }

  // --------------------------------------------------------------------------
  // Settlements — manual entry, OWNER/MANAGER/ACCOUNTANT only.
  // --------------------------------------------------------------------------
  @Post('settlements')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async createSettlement(@Body() body: CreateSettlementDto, @Req() req: any) {
    const currentEmployee = req.employee;

    if (!body.locationId || !body.periodStart || !body.periodEnd || body.amountEarned === undefined) {
      throw new HttpException(
        {
          success: false,
          message: 'Missing required fields: locationId, periodStart, periodEnd, amountEarned',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const settlement = await this.yastasService.createSettlement({
      locationId: body.locationId,
      periodStart: new Date(body.periodStart),
      periodEnd: new Date(body.periodEnd),
      amountEarned: body.amountEarned,
      notes: body.notes,
      createdBy: currentEmployee.id,
    });

    return { success: true, data: settlement };
  }

  @Patch('settlements/:id')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async updateSettlement(@Param('id') id: string, @Body() body: UpdateSettlementDto) {
    const settlement = await this.yastasService.updateSettlement(id, {
      status: body.status,
      reportedAt: body.reportedAt ? new Date(body.reportedAt) : undefined,
      paidAt: body.paidAt ? new Date(body.paidAt) : undefined,
    });

    return { success: true, data: settlement };
  }

  // --------------------------------------------------------------------------
  // Opening balance cutover — one-time per location, go-live seed.
  // OWNER only: same significance as the historical-cost cutover approval.
  // --------------------------------------------------------------------------
  @Post('wallets/:locationId/opening-balance')
  @Roles('OWNER')
  async setOpeningBalance(@Param('locationId') locationId: string, @Body() body: SetOpeningBalanceDto) {
    if (body.amount === undefined) {
      throw new HttpException(
        { success: false, message: 'Missing required field: amount' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const wallet = await this.yastasService.setOpeningBalance(locationId, body.amount);
    return { success: true, data: wallet };
  }

  // --------------------------------------------------------------------------
  // Read endpoints — minimal, for a future balance/history screen.
  // --------------------------------------------------------------------------
  @Get('wallets/:locationId')
  async getWallet(@Param('locationId') locationId: string) {
    const wallet = await this.yastasService.getWallet(locationId);
    return { success: true, data: wallet };
  }

  @Get('operations')
  async listOperations(
    @Query('locationId') locationId?: string,
    @Query('employeeId') employeeId?: string,
    @Query('direction') direction?: YastasOperationDirection,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const operations = await this.yastasService.listOperations({
      locationId,
      employeeId,
      direction,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    });

    return { success: true, count: operations.length, data: operations };
  }

  @Get('settlements')
  async listSettlements(@Query('locationId') locationId?: string) {
    const settlements = await this.yastasService.listSettlements(locationId);
    return { success: true, count: settlements.length, data: settlements };
  }
}
