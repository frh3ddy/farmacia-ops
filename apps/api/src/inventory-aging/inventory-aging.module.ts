import { Module } from '@nestjs/common';
import { InventoryAgingController } from './inventory-aging.controller';
import { InventoryAgingService } from './inventory-aging.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [InventoryAgingController],
  providers: [InventoryAgingService, PrismaService],
  exports: [InventoryAgingService],
})
export class InventoryAgingModule {}

