import { Module } from '@nestjs/common';
import { WebhooksModule } from './webhooks/webhooks.module';
import { PrismaService } from './prisma/prisma.service';
import { LocationsController } from './locations/locations.controller';

@Module({
  imports: [WebhooksModule],
  controllers: [LocationsController],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class AppModule {}


