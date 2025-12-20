import {
    Controller,
    Post,
    Headers,
    Req,
    Res,
    HttpStatus,
  } from '@nestjs/common';
  import { Request, Response } from 'express';
  import crypto from 'crypto';
  import { SaleQueue } from '../queues/sale.queue';
  
  @Controller('webhooks/square')
  export class SquareWebhookController {
    constructor(private readonly saleQueue: SaleQueue) {}
  
    @Post()
    async handle(
      @Req() req: Request,
      @Res() res: Response,
      @Headers('x-square-signature') signature: string,
    ) {
      const body = JSON.stringify(req.body);
  
      if (!this.verifySignature(body, signature)) {
        return res.status(HttpStatus.UNAUTHORIZED).send('Invalid signature');
      }
  
      const event = req.body;
  
      // Only process relevant events
      if (event.type !== 'payment.created') {
        return res.status(HttpStatus.OK).send('Ignored');
      }
  
      await this.saleQueue.enqueue(event);
  
      return res.status(HttpStatus.OK).send('Accepted');
    }
  
    private verifySignature(body: string, signature: string): boolean {
      const hmac = crypto
        .createHmac('sha256', process.env.SQUARE_WEBHOOK_SECRET!)
        .update(body)
        .digest('base64');
  
      return hmac === signature;
    }
  }