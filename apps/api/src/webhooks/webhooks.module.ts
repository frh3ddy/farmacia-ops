import { Module } from '@nestjs/common';
import { SquareWebhookController, SalesTestController } from './square.controller';
import { SaleQueue } from '../queues/sale.queue';
import { SalesTestService } from './sales-test.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { UnmatchedLinesController } from '../sales/unmatched-lines.controller';

@Module({
  imports: [AuthModule],
  // UnmatchedLinesController lives here because it shares this module's SaleQueue.
  controllers: [SquareWebhookController, SalesTestController, UnmatchedLinesController],
  providers: [SaleQueue, SalesTestService, PrismaService],
})
export class WebhooksModule {}