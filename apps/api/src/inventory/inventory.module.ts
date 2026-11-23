import { Module, forwardRef } from '@nestjs/common';
import { InventoryReconciliationController } from './inventory-reconciliation.controller';
import { InventoryReconciliationService } from './inventory-reconciliation.service';
import { InventoryAdjustmentController } from './inventory-adjustment.controller';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { BreakBulkController } from './break-bulk.controller';
import { InternalBreakBulkController } from './internal-break-bulk.controller';
import { InternalExpensesController } from './internal-expenses.controller';
import { BreakBulkService } from './break-bulk.service';
import { TransferController } from './transfer.controller';
import { TransferService } from './transfer.service';
import { InventoryReceivingController } from './inventory-receiving.controller';
import { InventoryReceivingService } from './inventory-receiving.service';
import { InventoryReportsController } from './inventory-reports.controller';
import { InventoryReportsService } from './inventory-reports.service';
import { ExpenseController } from './expense.controller';
import { RecurringExpenseController } from './recurring-expense.controller';
import { RecurringExpenseService } from './recurring-expense.service';
import { LaborModule } from '../labor/labor.module';
import { ExpenseService } from './expense.service';
import { StockCountController } from './stock-count.controller';
import { InventoryLotsController } from './inventory-lots.controller';
import { StockCountService } from './stock-count.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [forwardRef(() => AuthModule), ProductsModule, LaborModule],
  controllers: [
    InventoryReconciliationController,
    InventoryAdjustmentController,
    BreakBulkController,
    InternalBreakBulkController,
    InternalExpensesController,
    TransferController,
    InventoryReceivingController,
    InventoryReportsController,
    RecurringExpenseController, // before ExpenseController: its /expenses/:id would match /expenses/recurring
    ExpenseController,
    StockCountController,
    InventoryLotsController,
  ],
  providers: [
    RecurringExpenseService,
    InventoryReconciliationService,
    InventoryAdjustmentService,
    BreakBulkService,
    TransferService,
    InventoryReceivingService,
    InventoryReportsService,
    ExpenseService,
    StockCountService,
    PrismaService,
  ],
  exports: [
    InventoryReconciliationService,
    InventoryAdjustmentService,
    BreakBulkService,
    TransferService,
    InventoryReceivingService,
    InventoryReportsService,
    ExpenseService,
  ],
})
export class InventoryModule {}
