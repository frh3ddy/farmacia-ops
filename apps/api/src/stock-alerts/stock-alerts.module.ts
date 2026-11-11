import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InternalStockAlertsController } from './internal-stock-alerts.controller';

@Module({
  controllers: [InternalStockAlertsController],
  providers: [PrismaService],
})
export class StockAlertsModule {}
