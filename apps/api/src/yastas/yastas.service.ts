import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma, WalletMovementType, YastasOperationDirection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// ============================================================================
// Yastás banking-correspondent ledger — OUT operations, wallet transfers,
// settlements, and the read endpoints a future UI needs. IN operations are
// written by the sale worker (apps/worker/src/sale.worker.ts), not here.
// Never touches Sale/SaleItem/InventoryConsumption/FIFO.
// ============================================================================

@Injectable()
export class YastasService {
  constructor(private readonly prisma: PrismaService) {}

  private async getWalletOrThrow(locationId: string) {
    const wallet = await this.prisma.yastasWallet.findUnique({ where: { locationId } });
    if (!wallet) {
      throw new HttpException(
        { success: false, message: `No YastasWallet for location ${locationId} — run the opening-balance cutover first` },
        HttpStatus.NOT_FOUND,
      );
    }
    return wallet;
  }

  // --------------------------------------------------------------------------
  // Opening balance cutover — one-time per location, go-live seed. Mirrors
  // scripts/seed-yastas-opening-balance.ts; refuses a second OPENING_BALANCE
  // movement for the same wallet (app-enforced, not a DB constraint).
  // --------------------------------------------------------------------------
  async setOpeningBalance(locationId: string, amount: number) {
    if (!amount || amount < 0) {
      throw new HttpException(
        { success: false, message: 'amount must be non-negative' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const location = await this.prisma.location.findUnique({ where: { id: locationId } });
    if (!location) {
      throw new HttpException(
        { success: false, message: `Location ${locationId} not found` },
        HttpStatus.NOT_FOUND,
      );
    }

    const existingWallet = await this.prisma.yastasWallet.findUnique({ where: { locationId } });
    if (existingWallet) {
      const existingOpening = await this.prisma.walletMovement.findFirst({
        where: { walletId: existingWallet.id, type: WalletMovementType.OPENING_BALANCE },
      });
      if (existingOpening) {
        throw new HttpException(
          { success: false, message: `${location.name} already has an opening balance (${existingOpening.id}) — refusing to seed a second one` },
          HttpStatus.CONFLICT,
        );
      }
    }

    const decimalAmount = new Prisma.Decimal(amount);
    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.yastasWallet.upsert({
        where: { locationId },
        create: { locationId, balance: decimalAmount },
        update: { balance: decimalAmount },
      });
      await tx.walletMovement.create({
        data: { walletId: wallet.id, type: WalletMovementType.OPENING_BALANCE, amount: decimalAmount },
      });
      return wallet;
    });
  }

  // --------------------------------------------------------------------------
  // OUT operation — cash handed to the client, never touches Square.
  // --------------------------------------------------------------------------
  async recordOutOperation(input: {
    locationId: string;
    employeeId: string;
    faceAmount: number;
    yastasReceiptRef?: string;
  }) {
    if (!input.faceAmount || input.faceAmount <= 0) {
      throw new HttpException(
        { success: false, message: 'faceAmount must be positive' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const wallet = await this.getWalletOrThrow(input.locationId);
    const faceAmount = new Prisma.Decimal(input.faceAmount);

    return this.prisma.$transaction(async (tx) => {
      const operation = await tx.yastasOperation.create({
        data: {
          employeeId: input.employeeId,
          locationId: input.locationId,
          direction: YastasOperationDirection.OUT,
          faceAmount,
          yastasReceiptRef: input.yastasReceiptRef,
        },
      });
      await tx.walletMovement.create({
        data: {
          walletId: wallet.id,
          type: WalletMovementType.OPERATION_CREDIT,
          amount: faceAmount,
          relatedOperationId: operation.id,
        },
      });
      const updatedWallet = await tx.yastasWallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: faceAmount } },
      });
      return { operation, wallet: updatedWallet };
    });
  }

  // --------------------------------------------------------------------------
  // Wallet transfer — instant, both movements posted atomically.
  // --------------------------------------------------------------------------
  async createWalletTransfer(input: {
    fromLocationId: string;
    toLocationId: string;
    amount: number;
    createdBy: string;
  }) {
    if (input.fromLocationId === input.toLocationId) {
      throw new HttpException(
        { success: false, message: 'fromLocationId and toLocationId must differ' },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!input.amount || input.amount <= 0) {
      throw new HttpException(
        { success: false, message: 'amount must be positive' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const [fromWallet, toWallet] = await Promise.all([
      this.getWalletOrThrow(input.fromLocationId),
      this.getWalletOrThrow(input.toLocationId),
    ]);
    const amount = new Prisma.Decimal(input.amount);

    if (fromWallet.balance.lt(amount)) {
      throw new HttpException(
        { success: false, message: 'Insufficient balance at source location' },
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const transfer = await tx.yastasWalletTransfer.create({
        data: {
          fromLocationId: input.fromLocationId,
          toLocationId: input.toLocationId,
          amount,
          createdBy: input.createdBy,
        },
      });
      await tx.walletMovement.create({
        data: {
          walletId: fromWallet.id,
          type: WalletMovementType.TRANSFER_OUT,
          amount: amount.neg(),
          relatedTransferId: transfer.id,
        },
      });
      await tx.walletMovement.create({
        data: {
          walletId: toWallet.id,
          type: WalletMovementType.TRANSFER_IN,
          amount,
          relatedTransferId: transfer.id,
        },
      });
      await tx.yastasWallet.update({ where: { id: fromWallet.id }, data: { balance: { decrement: amount } } });
      await tx.yastasWallet.update({ where: { id: toWallet.id }, data: { balance: { increment: amount } } });
      return transfer;
    });
  }

  // --------------------------------------------------------------------------
  // Settlements — manual entry, no importer for v1.
  // --------------------------------------------------------------------------
  async createSettlement(input: {
    locationId: string;
    periodStart: Date;
    periodEnd: Date;
    amountEarned: number;
    notes?: string;
    createdBy?: string;
  }) {
    return this.prisma.yastasSettlement.create({
      data: {
        locationId: input.locationId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        amountEarned: new Prisma.Decimal(input.amountEarned),
        notes: input.notes,
        createdBy: input.createdBy,
      },
    });
  }

  async updateSettlement(
    id: string,
    updates: { status?: 'PROVISIONAL' | 'CONFIRMED'; reportedAt?: Date; paidAt?: Date },
  ) {
    const existing = await this.prisma.yastasSettlement.findUnique({ where: { id } });
    if (!existing) {
      throw new HttpException(
        { success: false, message: `Settlement ${id} not found` },
        HttpStatus.NOT_FOUND,
      );
    }
    return this.prisma.yastasSettlement.update({ where: { id }, data: updates });
  }

  // --------------------------------------------------------------------------
  // Read endpoints — minimal, unblock a future screen.
  // --------------------------------------------------------------------------
  async getWallet(locationId: string) {
    const wallet = await this.getWalletOrThrow(locationId);
    return { locationId: wallet.locationId, balance: wallet.balance, updatedAt: wallet.updatedAt };
  }

  async listOperations(filter: {
    locationId?: string;
    employeeId?: string;
    direction?: YastasOperationDirection;
    startDate?: Date;
    endDate?: Date;
  }) {
    const where: Prisma.YastasOperationWhereInput = {
      ...(filter.locationId && { locationId: filter.locationId }),
      ...(filter.employeeId && { employeeId: filter.employeeId }),
      ...(filter.direction && { direction: filter.direction }),
      ...((filter.startDate || filter.endDate) && {
        occurredAt: {
          ...(filter.startDate && { gte: filter.startDate }),
          ...(filter.endDate && { lte: filter.endDate }),
        },
      }),
    };
    return this.prisma.yastasOperation.findMany({ where, orderBy: { occurredAt: 'desc' }, take: 200 });
  }

  async listSettlements(locationId?: string) {
    return this.prisma.yastasSettlement.findMany({
      where: { ...(locationId && { locationId }) },
      orderBy: { periodStart: 'desc' },
      take: 100,
    });
  }
}
