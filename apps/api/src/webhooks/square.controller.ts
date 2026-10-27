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
    Logger,
  } from '@nestjs/common';
  import { Request, Response } from 'express';
  import { WebhooksHelper } from 'square';
  import { SaleQueue } from '../queues/sale.queue';
  import { SalesTestService, CreateTestSaleInput } from './sales-test.service';
  import { AuthGuard, Roles } from '../auth/guards/auth.guard';

  @Controller('webhooks/square')
  export class SquareWebhookController {
    private readonly logger = new Logger(SquareWebhookController.name);

    constructor(
      private readonly saleQueue: SaleQueue,
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
      this.logger.debug(`Received webhook request (hasSignature=${!!signature}, hasRawBody=${!!req.rawBody})`);

      // 1. Safety Check: Ensure raw body exists
      if (!req.rawBody) {
        this.logger.error('Raw body is missing — ensure "rawBody: true" is set in main.ts');
        throw new BadRequestException('Raw body is missing. Ensure "rawBody: true" is set in main.ts');
      }

      // 2. Validate webhook signature
      const signatureKey = process.env.SQUARE_WEBHOOK_SECRET;
      const notificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;

      if (!signatureKey) {
        this.logger.error('SQUARE_WEBHOOK_SECRET not set');
        throw new BadRequestException('SQUARE_WEBHOOK_SECRET environment variable is not set');
      }

      if (!notificationUrl) {
        this.logger.error('SQUARE_WEBHOOK_NOTIFICATION_URL not set');
        throw new BadRequestException('SQUARE_WEBHOOK_NOTIFICATION_URL environment variable is not set');
      }

      if (!signature) {
        this.logger.warn('Webhook request missing signature header');
        throw new UnauthorizedException('Missing webhook signature');
      }

      const isValid = await WebhooksHelper.verifySignature({
        requestBody: req.rawBody.toString('utf-8'),
        signatureHeader: signature,
        signatureKey: signatureKey,
        notificationUrl: notificationUrl
      });

      if (!isValid) {
        this.logger.warn('Invalid webhook signature');
        throw new UnauthorizedException('Invalid webhook signature');
      }
      this.logger.debug('Signature verified');

      // 3. Convert Buffer to String
      const rawBodyString = req.rawBody.toString('utf-8');

      // 4. Parse the body for processing
      let event: any;
      try {
        event = JSON.parse(rawBodyString);
        this.logger.debug(`Event parsed: type=${event.type} id=${event.event_id}`);
      } catch (error) {
        this.logger.error('Failed to parse webhook JSON body', error instanceof Error ? error.stack : undefined);
        return res.status(HttpStatus.BAD_REQUEST).send('Invalid JSON');
      }

      // Only process relevant events
      if (event.type !== 'payment.created') {
        this.logger.debug(`Ignoring event type ${event.type} (expected payment.created)`);
        return res.status(HttpStatus.OK).send('Ignored');
      }

      await this.saleQueue.enqueue(event);
      this.logger.debug(`Event ${event.event_id} enqueued`);

      return res.status(HttpStatus.OK).send('Accepted');
    }
  
  }

  // ============================================================================
  // Sales Testing Controller - For testing sales with real product data
  // ============================================================================
  @Controller('api/sales-test')
  @UseGuards(AuthGuard)
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