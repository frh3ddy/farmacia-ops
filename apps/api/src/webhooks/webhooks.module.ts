import { Module } from '@nestjs/common';
import { SquareWebhookController, WebhookTestController, SalesTestController } from './square.controller';
import { SaleQueue } from '../queues/sale.queue';
import { WebhookTestService } from './webhook-test.service';
import { SalesTestService } from './sales-test.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [SquareWebhookController, WebhookTestController, SalesTestController],
  providers: [SaleQueue, WebhookTestService, SalesTestService, PrismaService],
})
export class WebhooksModule {}