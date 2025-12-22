import { Module } from '@nestjs/common';
import { WebhooksModule } from './webhooks/webhooks.module';
import { CatalogModule } from './catalog/catalog.module';
import { DataModule } from './data/data.module';
import { PrismaService } from './prisma/prisma.service';
import { LocationsController } from './locations/locations.controller';

@Module({
  imports: [WebhooksModule, CatalogModule, DataModule],
  controllers: [LocationsController],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class AppModule {}


