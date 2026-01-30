import { Module } from '@nestjs/common';
import { InventoryReconciliationController } from './inventory-reconciliation.controller';
import { InventoryReconciliationService } from './inventory-reconciliation.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [InventoryReconciliationController],
  providers: [InventoryReconciliationService, PrismaService],
  exports: [InventoryReconciliationService],
})
export class InventoryModule {}
