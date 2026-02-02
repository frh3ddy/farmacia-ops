import { Module, forwardRef } from '@nestjs/common';
import { InventoryReconciliationController } from './inventory-reconciliation.controller';
import { InventoryReconciliationService } from './inventory-reconciliation.service';
import { InventoryAdjustmentController } from './inventory-adjustment.controller';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { InventoryReceivingController } from './inventory-receiving.controller';
import { InventoryReceivingService } from './inventory-receiving.service';
import { InventoryReportsController } from './inventory-reports.controller';
import { InventoryReportsService } from './inventory-reports.service';
import { ExpenseController } from './expense.controller';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [
    InventoryReconciliationController,
    InventoryAdjustmentController,
    InventoryReceivingController,
    InventoryReportsController,
    ExpenseController,
  ],
  providers: [
    InventoryReconciliationService,
    InventoryAdjustmentService,
    InventoryReceivingService,
    InventoryReportsService,
    ExpenseService,
    PrismaService,
  ],
  exports: [
    InventoryReconciliationService,
    InventoryAdjustmentService,
    InventoryReceivingService,
    InventoryReportsService,
    ExpenseService,
  ],
})
export class InventoryModule {}
