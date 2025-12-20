import {
    Controller,
    Get,
    Post,
    Headers,
    Req,
    Res,
    HttpStatus,
    HttpCode,
    RawBodyRequest,
    BadRequestException,
    UnauthorizedException
  } from '@nestjs/common';
  import { Request, Response } from 'express';
  import { WebhooksHelper } from 'square';
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
    @HttpCode(200)
    async handle(
      @Headers('x-square-hmacsha256-signature') signature: string,
      @Req() req: RawBodyRequest<Request>,
      @Res() res: Response,
    ) {

      // 1. Safety Check: Ensure raw body exists
      if (!req.rawBody) {
        throw new BadRequestException('Raw body is missing. Ensure "rawBody: true" is set in main.ts');
      }

      // 2. Validate webhook signature
      const signatureKey = process.env.SQUARE_WEBHOOK_SECRET;
      const notificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
      
      if (!signatureKey) {
        throw new BadRequestException('SQUARE_WEBHOOK_SECRET environment variable is not set');
      }
      
      if (!notificationUrl) {
        throw new BadRequestException('SQUARE_WEBHOOK_NOTIFICATION_URL environment variable is not set');
      }

      if (!signature) {
        throw new UnauthorizedException('Missing webhook signature');
      }

      const isValid = await WebhooksHelper.verifySignature({
        requestBody: req.rawBody.toString('utf-8'),
        signatureHeader: signature,
        signatureKey: signatureKey,
        notificationUrl: notificationUrl
      });

      if (!isValid) {
        throw new UnauthorizedException('Invalid webhook signature');
      }

      // 3. Convert Buffer to String
      const rawBodyString = req.rawBody.toString('utf-8');
    
      // 4. Parse the body for processing
      let event: any;
      try {
        event = JSON.parse(rawBodyString);
      } catch (error) {
        console.error('Failed to parse webhook body as JSON:', error);
        return res.status(HttpStatus.BAD_REQUEST).send('Invalid JSON');
      }
    console.log('event', event);
      // Only process relevant events
      // if (event.type !== 'payment.created') {
      //   return res.status(HttpStatus.OK).send('Ignored');
      // }
    
      await this.saleQueue.enqueue(event);
    
      return res.status(HttpStatus.OK).send('Accepted');
    }
  
  }