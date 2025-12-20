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
  ) {
    // Get signature from headers (handle both string and array formats)
    const signatureHeader = req.headers['x-square-signature'];
    const signature = Array.isArray(signatureHeader) 
      ? signatureHeader[0] 
      : signatureHeader;
    
    // Get raw body as Buffer (from express.raw middleware)
    const rawBody = req.body as Buffer;
    
    // Check if raw body exists
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      console.error('Raw body is missing or not a Buffer', {
        bodyType: typeof req.body,
        isBuffer: Buffer.isBuffer(req.body),
      });
      return res.status(HttpStatus.BAD_REQUEST).send('Invalid request body');
    }
    
    const bodyString = rawBody.toString('utf8');
    
    // Check if signature header exists
    if (!signature) {
      console.error('Missing x-square-signature header', {
        headers: Object.keys(req.headers),
        allHeaders: req.headers,
      });
      return res.status(HttpStatus.UNAUTHORIZED).send('Missing signature');
    }
    
    // Check if webhook secret is configured
    const webhookSecret = process.env.SQUARE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('SQUARE_WEBHOOK_SECRET is not configured');
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Server configuration error');
    }
  
    if (!this.verifySignature(bodyString, signature, webhookSecret)) {
      console.error('Signature verification failed', {
        signatureReceived: signature,
        bodyLength: bodyString.length,
        bodyPreview: bodyString.substring(0, 100),
      });
      return res.status(HttpStatus.UNAUTHORIZED).send('Invalid signature');
    }
  
    // Parse the body for processing
    let event: any;
    try {
      event = JSON.parse(bodyString);
    } catch (error) {
      console.error('Failed to parse webhook body as JSON:', error);
      return res.status(HttpStatus.BAD_REQUEST).send('Invalid JSON');
    }
  
    // Only process relevant events
    if (event.type !== 'payment.created') {
      return res.status(HttpStatus.OK).send('Ignored');
    }
  
    await this.saleQueue.enqueue(event);
  
    return res.status(HttpStatus.OK).send('Accepted');
  }
  
    private verifySignature(body: string, signature: string, secret: string): boolean {
      try {
        const hmac = crypto
          .createHmac('sha256', secret)
          .update(body)
          .digest('base64');
        
        // Use constant-time comparison to prevent timing attacks
        // Both buffers must be the same length for timingSafeEqual
        const hmacBuffer = Buffer.from(hmac);
        const signatureBuffer = Buffer.from(signature);
        
        if (hmacBuffer.length !== signatureBuffer.length) {
          console.error('Signature length mismatch', {
            hmacLength: hmacBuffer.length,
            signatureLength: signatureBuffer.length,
          });
          return false;
        }
        
        return crypto.timingSafeEqual(hmacBuffer, signatureBuffer);
      } catch (error) {
        console.error('Error during signature verification:', error);
        return false;
      }
    }
  }