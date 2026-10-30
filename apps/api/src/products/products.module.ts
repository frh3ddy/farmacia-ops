import { Module, forwardRef } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { MedicationEquivalenceService } from './medication-equivalence.service';
import { CatalogSearchService } from './catalog-search.service';
import { ReferenceDataService } from './reference-data.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { InventoryAgingModule } from '../inventory-aging/inventory-aging.module';

@Module({
  imports: [forwardRef(() => AuthModule), InventoryAgingModule],
  controllers: [ProductsController],
  providers: [ProductsService, MedicationEquivalenceService, CatalogSearchService, ReferenceDataService, PrismaService],
  exports: [ProductsService],
})
export class ProductsModule {}
