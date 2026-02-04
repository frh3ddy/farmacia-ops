import { Module } from '@nestjs/common';
import { WebhooksModule } from './webhooks/webhooks.module';
import { CatalogModule } from './catalog/catalog.module';
import { DataModule } from './data/data.module';
import { InventoryAgingModule } from './inventory-aging/inventory-aging.module';
import { InventoryMigrationModule } from './inventory-migration/inventory-migration.module';
import { InventoryModule } from './inventory/inventory.module';
import { AuthModule } from './auth/auth.module';
import { LocationsModule } from './locations/locations.module';
import { ProductsModule } from './products/products.module';
import { PrismaService } from './prisma/prisma.service';

@Module({
  imports: [
    WebhooksModule,
    CatalogModule,
    DataModule,
    InventoryAgingModule,
    InventoryMigrationModule,
    InventoryModule,
    AuthModule,
    LocationsModule,
    ProductsModule,
  ],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class AppModule {}


