import { Module } from '@nestjs/common';
import { InventoryReconciliationController } from './inventory-reconciliation.controller';
import { InventoryReconciliationService } from './inventory-reconciliation.service';
import { InventoryAdjustmentController } from './inventory-adjustment.controller';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { InventoryReceivingController } from './inventory-receiving.controller';
import { InventoryReceivingService } from './inventory-receiving.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [
    InventoryReconciliationController,
    InventoryAdjustmentController,
    InventoryReceivingController,
  ],
  providers: [
    InventoryReconciliationService,
    InventoryAdjustmentService,
    InventoryReceivingService,
    PrismaService,
  ],
  exports: [
    InventoryReconciliationService,
    InventoryAdjustmentService,
    InventoryReceivingService,
  ],
})
export class InventoryModule {}
