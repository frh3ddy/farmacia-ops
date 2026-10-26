import { Module } from '@nestjs/common';
import { SquareWebhookController, SalesTestController } from './square.controller';
import { SaleQueue } from '../queues/sale.queue';
import { SalesTestService } from './sales-test.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [SquareWebhookController, SalesTestController],
  providers: [SaleQueue, SalesTestService, PrismaService],
})
export class WebhooksModule {}