import {
    Controller,
    Get,
    Post,
    Headers,
    Req,
    Res,
    Body,
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
  
  }

  @Controller('api/webhooks/square')
  export class WebhookTestController {
    constructor(private readonly saleQueue: SaleQueue) {}
    
    @Post('test')
    @HttpCode(200)
    async testWebhook(@Req() req: Request) {
      // Test endpoint to simulate Square webhook without signature verification
      // Useful for testing sale processing
      const body = req.body;
      
      // Create a mock Square webhook event structure
      const mockEvent = {
        type: 'payment.created',
        event_id: `test_${Date.now()}`,
        data: body.data || {
          type: 'payment',
          id: body.paymentId || `test_payment_${Date.now()}`,
          object: {
            payment: {
              id: body.paymentId || `test_payment_${Date.now()}`,
              location_id: body.locationId || 'L60AMVPDZJ48F',
              order_id: body.orderId || `test_order_${Date.now()}`,
              created_at: new Date().toISOString(),
              status: 'APPROVED',
              amount_money: {
                amount: body.amount || 100,
                currency: 'USD',
              },
              total_money: {
                amount: body.amount || 100,
                currency: 'USD',
              },
            },
          },
        },
      };
      
      console.log('[DEBUG] [WEBHOOK_TEST] Simulating webhook event:', mockEvent.event_id);
      
      try {
        await this.saleQueue.enqueue(mockEvent);
        return {
          success: true,
          message: 'Test webhook enqueued successfully',
          eventId: mockEvent.event_id,
        };
      } catch (error) {
        return {
          success: false,
          message: `Failed to enqueue test webhook: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  
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
      console.log('[DEBUG] [WEBHOOK] ========================================');
      console.log('[DEBUG] [WEBHOOK] Received webhook request');
      console.log('[DEBUG] [WEBHOOK] Has signature header:', !!signature);
      console.log('[DEBUG] [WEBHOOK] Has rawBody:', !!req.rawBody);

      // 1. Safety Check: Ensure raw body exists
      if (!req.rawBody) {
        console.error('[DEBUG] [WEBHOOK] ERROR: Raw body is missing');
        throw new BadRequestException('Raw body is missing. Ensure "rawBody: true" is set in main.ts');
      }
      console.log('[DEBUG] [WEBHOOK] ✓ Raw body exists');

      // 2. Validate webhook signature
      const signatureKey = process.env.SQUARE_WEBHOOK_SECRET;
      const notificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
      
      console.log('[DEBUG] [WEBHOOK] Checking environment variables...');
      console.log('[DEBUG] [WEBHOOK] Has SQUARE_WEBHOOK_SECRET:', !!signatureKey);
      console.log('[DEBUG] [WEBHOOK] Has SQUARE_WEBHOOK_NOTIFICATION_URL:', !!notificationUrl);
      
      if (!signatureKey) {
        console.error('[DEBUG] [WEBHOOK] ERROR: SQUARE_WEBHOOK_SECRET not set');
        throw new BadRequestException('SQUARE_WEBHOOK_SECRET environment variable is not set');
      }
      
      if (!notificationUrl) {
        console.error('[DEBUG] [WEBHOOK] ERROR: SQUARE_WEBHOOK_NOTIFICATION_URL not set');
        throw new BadRequestException('SQUARE_WEBHOOK_NOTIFICATION_URL environment variable is not set');
      }

      if (!signature) {
        console.error('[DEBUG] [WEBHOOK] ERROR: Missing signature header');
        throw new UnauthorizedException('Missing webhook signature');
      }
      console.log('[DEBUG] [WEBHOOK] ✓ Signature header present');

      console.log('[DEBUG] [WEBHOOK] Verifying signature...');
      const isValid = await WebhooksHelper.verifySignature({
        requestBody: req.rawBody.toString('utf-8'),
        signatureHeader: signature,
        signatureKey: signatureKey,
        notificationUrl: notificationUrl
      });

      if (!isValid) {
        console.error('[DEBUG] [WEBHOOK] ERROR: Invalid webhook signature');
        throw new UnauthorizedException('Invalid webhook signature');
      }
      console.log('[DEBUG] [WEBHOOK] ✓ Signature verified');

      // 3. Convert Buffer to String
      const rawBodyString = req.rawBody.toString('utf-8');
      console.log('[DEBUG] [WEBHOOK] Raw body length:', rawBodyString.length);
    
      // 4. Parse the body for processing
      let event: any;
      try {
        event = JSON.parse(rawBodyString);
        console.log('[DEBUG] [WEBHOOK] ✓ Event parsed successfully');
        console.log('[DEBUG] [WEBHOOK] Event type:', event.type);
        console.log('[DEBUG] [WEBHOOK] Event ID:', event.event_id);
      } catch (error) {
        console.error('[DEBUG] [WEBHOOK] ERROR: Failed to parse JSON:', error);
        return res.status(HttpStatus.BAD_REQUEST).send('Invalid JSON');
      }
      
      // Only process relevant events
      console.log('[DEBUG] [WEBHOOK] Checking event type...');
      console.log('[DEBUG] [WEBHOOK] Event type:', event.type, 'Expected: payment.created');
      if (event.type !== 'payment.created') {
        console.log('[DEBUG] [WEBHOOK] ⚠️ Event type mismatch, ignoring');
        return res.status(HttpStatus.OK).send('Ignored');
      }
      console.log('[DEBUG] [WEBHOOK] ✓ Event type matches, proceeding to enqueue');
    
      console.log('[DEBUG] [WEBHOOK] Calling saleQueue.enqueue()...');
      await this.saleQueue.enqueue(event);
      console.log('[DEBUG] [WEBHOOK] ✓ Event enqueued successfully');
      console.log('[DEBUG] [WEBHOOK] ========================================');
    
      return res.status(HttpStatus.OK).send('Accepted');
    }
  
  }