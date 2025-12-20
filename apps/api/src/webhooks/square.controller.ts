import {
    Controller,
    Get,
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
  
  @Get()
  async get() {
    return {
      message: 'Square webhook endpoint',
      method: 'POST',
      status: 'active',
    };
  }
  
  @Post()
  async handle(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('x-square-signature') signature: string,
  ) {
    // Get raw body as Buffer (from express.raw middleware)
    const rawBody = req.body as Buffer;
    const bodyString = rawBody.toString('utf8');
  
    if (!this.verifySignature(bodyString, signature)) {
      return res.status(HttpStatus.UNAUTHORIZED).send('Invalid signature');
    }
  
    // Parse the body for processing
    const event = JSON.parse(bodyString);
  
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