import { Module, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';
import { InternalStockAlertsController } from './internal-stock-alerts.controller';
import { ProductPauseController } from './product-pause.controller';
import { PauseSuggestionsController } from './pause-suggestions.controller';

@Module({
  imports: [forwardRef(() => AuthModule), ProductsModule],
  controllers: [InternalStockAlertsController, ProductPauseController, PauseSuggestionsController],
  providers: [PrismaService],
})
export class StockAlertsModule {}
