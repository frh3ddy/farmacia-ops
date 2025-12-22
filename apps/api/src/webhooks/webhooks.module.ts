import { Module } from '@nestjs/common';
import { SquareWebhookController, WebhookTestController } from './square.controller';
import { SaleQueue } from '../queues/sale.queue';
import { WebhookTestService } from './webhook-test.service';

@Module({
  controllers: [SquareWebhookController, WebhookTestController],
  providers: [SaleQueue, WebhookTestService],
})
export class WebhooksModule {}