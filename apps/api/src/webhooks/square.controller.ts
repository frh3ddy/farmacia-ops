import {
    Controller,
    Get,
    Post,
    Headers,
    Req,
    Res,
    Body,
    Query,
    HttpStatus,
    HttpCode,
    RawBodyRequest,
    BadRequestException,
    UnauthorizedException,
    UseGuards,
  } from '@nestjs/common';
  import { Request, Response } from 'express';
  import { WebhooksHelper } from 'square';
  import { SaleQueue } from '../queues/sale.queue';
  import { WebhookTestService } from './webhook-test.service';
  import { SalesTestService, CreateTestSaleInput } from './sales-test.service';
  import { AuthGuard, RoleGuard, Roles } from '../auth/guards/auth.guard';
  
  @Controller('webhooks/square')
  export class SquareWebhookController {
    constructor(
      private readonly saleQueue: SaleQueue,
      private readonly webhookTestService: WebhookTestService,
    ) {}
  
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
      console.log('[DEBUG] [WEBHOOK] ✓ Event type matches');

      // Check if webhook processing is paused
      if (this.webhookTestService.isWebhookPaused()) {
        console.log('[DEBUG] [WEBHOOK] ⚠️ Webhook processing is paused, ignoring event');
        return res.status(HttpStatus.OK).send('Paused - Not Processed');
      }

      console.log('[DEBUG] [WEBHOOK] Proceeding to enqueue');
      console.log('[DEBUG] [WEBHOOK] Calling saleQueue.enqueue()...');
      await this.saleQueue.enqueue(event);
      console.log('[DEBUG] [WEBHOOK] ✓ Event enqueued successfully');
      console.log('[DEBUG] [WEBHOOK] ========================================');
    
      return res.status(HttpStatus.OK).send('Accepted');
    }
  
  }

  @Controller('api/webhooks/square')
  export class WebhookTestController {
    constructor(
      private readonly saleQueue: SaleQueue,
      private readonly webhookTestService: WebhookTestService,
      private readonly salesTestService: SalesTestService,
    ) {}
    
    @Get('test/status')
    getStatus() {
      return {
        success: true,
        ...this.webhookTestService.getStatus(),
      };
    }

    @Post('test/pause')
    pause() {
      // Only updates state - does NOT call enqueue
      this.webhookTestService.pause();
      return {
        success: true,
        message: 'Webhook testing paused',
        paused: true,
      };
    }

    @Post('test/resume')
    resume() {
      // Only updates state - does NOT call enqueue
      this.webhookTestService.resume();
      return {
        success: true,
        message: 'Webhook testing resumed',
        paused: false,
      };
    }
    
    @Post('test')
    @HttpCode(200)
    async testWebhook(@Req() req: Request) {
      // Check if webhook testing is paused - if so, return early without calling enqueue
      if (this.webhookTestService.isWebhookPaused()) {
        return {
          success: false,
          message: 'Webhook testing is paused. Please resume to send test webhooks.',
          paused: true,
        };
      }

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
        // Only reaches here if NOT paused - enqueue the test webhook
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
  }

  // ============================================================================
  // Sales Testing Controller - For testing sales with real product data
  // ============================================================================
  @Controller('api/sales-test')
  @UseGuards(AuthGuard, RoleGuard)
  export class SalesTestController {
    constructor(private readonly salesTestService: SalesTestService) {}

    /**
     * Get all active locations for sale testing
     */
    @Get('locations')
    @Roles('OWNER', 'MANAGER')
    async getLocations() {
      try {
        const locations = await this.salesTestService.getLocations();
        return {
          success: true,
          data: locations,
          count: locations.length,
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : 'Failed to get locations',
        };
      }
    }

    /**
     * Get products with inventory for a specific location
     * Only returns products that can be sold (have inventory and Square mapping)
     */
    @Get('products')
    @Roles('OWNER', 'MANAGER')
    async getProducts(@Query('locationId') locationId: string) {
      if (!locationId) {
        return {
          success: false,
          message: 'locationId query parameter is required',
        };
      }

      try {
        const products = await this.salesTestService.getProductsWithInventory(locationId);
        return {
          success: true,
          data: products,
          count: products.length,
          summary: {
            totalProducts: products.length,
            withSquareMapping: products.filter(p => p.hasSquareMapping).length,
            totalInventoryUnits: products.reduce((sum, p) => sum + p.totalInventory, 0),
          },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : 'Failed to get products',
        };
      }
    }

    /**
     * Create a test sale with specified products
     * This simulates a Square payment webhook and processes it through the worker
     * 
     * Request body:
     * {
     *   "locationId": "uuid",
     *   "lineItems": [
     *     { "productId": "uuid", "quantity": 1, "priceOverride": 19.99 }
     *   ]
     * }
     */
    @Post('create')
    @Roles('OWNER', 'MANAGER')
    @HttpCode(200)
    async createTestSale(@Body() input: CreateTestSaleInput) {
      if (!input.locationId) {
        return {
          success: false,
          message: 'locationId is required',
        };
      }

      if (!input.lineItems || !Array.isArray(input.lineItems) || input.lineItems.length === 0) {
        return {
          success: false,
          message: 'lineItems array is required and must not be empty',
        };
      }

      try {
        const result = await this.salesTestService.createTestSale(input);
        return result;
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : 'Failed to create test sale',
        };
      }
    }

    /**
     * Get queue status for monitoring
     */
    @Get('queue-status')
    @Roles('OWNER', 'MANAGER')
    async getQueueStatus() {
      try {
        const status = await this.salesTestService.getQueueStatus();
        return {
          success: true,
          data: status,
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : 'Failed to get queue status',
        };
      }
    }
  }