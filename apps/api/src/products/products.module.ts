import { Module, forwardRef } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { MedicationEquivalenceService } from './medication-equivalence.service';
import { CatalogSearchService } from './catalog-search.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [ProductsController],
  providers: [ProductsService, MedicationEquivalenceService, CatalogSearchService, PrismaService],
  exports: [ProductsService],
})
export class ProductsModule {}
