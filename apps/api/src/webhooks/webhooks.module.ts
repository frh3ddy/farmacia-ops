import { Module } from '@nestjs/common';
import { SquareWebhookController } from './square.controller';
import { SaleQueue } from '../queues/sale.queue';

@Module({
  controllers: [SquareWebhookController],
  providers: [SaleQueue],
})
export class WebhooksModule {}