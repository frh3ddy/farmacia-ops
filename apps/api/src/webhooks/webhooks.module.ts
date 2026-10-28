import { Module } from '@nestjs/common';
import { SquareWebhookController, SalesTestController } from './square.controller';
import { SaleQueue } from '../queues/sale.queue';
import { SalesTestService } from './sales-test.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { UnmatchedLinesController } from '../sales/unmatched-lines.controller';
import { SaleReturnsController } from '../sales/sale-returns.controller';

@Module({
  imports: [AuthModule],
  // The sales controllers live here because they share this module's SaleQueue.
  controllers: [SquareWebhookController, SalesTestController, UnmatchedLinesController, SaleReturnsController],
  providers: [SaleQueue, SalesTestService, PrismaService],
})
export class WebhooksModule {}