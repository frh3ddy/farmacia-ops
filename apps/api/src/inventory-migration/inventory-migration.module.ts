import { Module } from '@nestjs/common';
import { InventoryMigrationController } from './inventory-migration.controller';
import { InventoryMigrationService } from './inventory-migration.service';
import { SquareInventoryService } from './square-inventory.service';
import { CostExtractionService } from './cost-extraction.service';
import { CatalogMapperService } from './catalog-mapper.service';
import { SupplierService } from './supplier.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [InventoryMigrationController],
  providers: [
    InventoryMigrationService,
    SquareInventoryService,
    CostExtractionService,
    CatalogMapperService,
    SupplierService,
    PrismaService,
  ],
  exports: [InventoryMigrationService],
})
export class InventoryMigrationModule {}



