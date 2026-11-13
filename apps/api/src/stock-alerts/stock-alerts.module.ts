import { Module, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';
import { InternalStockAlertsController } from './internal-stock-alerts.controller';
import { ProductPauseController } from './product-pause.controller';

@Module({
  imports: [forwardRef(() => AuthModule), ProductsModule],
  controllers: [InternalStockAlertsController, ProductPauseController],
  providers: [PrismaService],
})
export class StockAlertsModule {}
