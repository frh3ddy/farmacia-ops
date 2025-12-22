import { Module } from '@nestjs/common';
import { SquareWebhookController, WebhookTestController } from './square.controller';
import { SaleQueue } from '../queues/sale.queue';

@Module({
  controllers: [SquareWebhookController, WebhookTestController],
  providers: [SaleQueue],
})
export class WebhooksModule {}