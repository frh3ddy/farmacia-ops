import { Module } from '@nestjs/common';
import { WebhooksModule } from './webhooks/webhooks.module';
import { CatalogModule } from './catalog/catalog.module';
import { DataModule } from './data/data.module';
import { InventoryAgingModule } from './inventory-aging/inventory-aging.module';
import { InventoryMigrationModule } from './inventory-migration/inventory-migration.module';
import { PrismaService } from './prisma/prisma.service';
import { LocationsController } from './locations/locations.controller';

@Module({
  imports: [
    WebhooksModule,
    CatalogModule,
    DataModule,
    InventoryAgingModule,
    InventoryMigrationModule,
  ],
  controllers: [LocationsController],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class AppModule {}


