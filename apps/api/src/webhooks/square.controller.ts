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
    // Get signature from headers - Square uses x-square-hmacsha256-signature or x-square-signature
    const signatureHeader = req.headers['x-square-hmacsha256-signature'] || req.headers['x-square-signature'];
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
    
    // Check if signature header exists
    if (!signature) {
      console.error('Missing signature header', {
        headers: Object.keys(req.headers),
        squareSignature: req.headers['x-square-signature'],
        squareHmacSignature: req.headers['x-square-hmacsha256-signature'],
      });
      return res.status(HttpStatus.UNAUTHORIZED).send('Missing signature');
    }
    
    // Check if webhook secret is configured
    let webhookSecret = process.env.SQUARE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('SQUARE_WEBHOOK_SECRET is not configured');
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Server configuration error');
    }
    
    // Trim whitespace from secret (common issue)
    webhookSecret = webhookSecret.trim();
    
    // Square's webhook signature key is base64-encoded, decode it
    let decodedSecret: string | Buffer;
    try {
      // Try to decode as base64 first (Square's format)
      decodedSecret = Buffer.from(webhookSecret, 'base64');
      console.log('Decoded webhook secret from base64', {
        originalLength: webhookSecret.length,
        decodedLength: decodedSecret.length,
      });
    } catch (error) {
      // If decoding fails, use the secret as-is (might already be decoded or in different format)
      console.log('Using webhook secret as-is (not base64)', {
        secretLength: webhookSecret.length,
      });
      decodedSecret = webhookSecret;
    }
  
    // Verify signature using raw body bytes directly (not string conversion)
    if (!this.verifySignature(rawBody, signature, decodedSecret)) {
      const bodyString = rawBody.toString('utf8');
      console.error('Signature verification failed', {
        signatureReceived: signature,
        signatureLength: signature.length,
        bodyLength: rawBody.length,
        bodyPreview: bodyString.substring(0, 100),
        secretLength: webhookSecret.length,
        secretPreview: webhookSecret.substring(0, 10) + '...',
      });
      return res.status(HttpStatus.UNAUTHORIZED).send('Invalid signature');
    }
  
    // Parse the body for processing
    const bodyString = rawBody.toString('utf8');
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
  
    private verifySignature(body: Buffer, signature: string, secret: string | Buffer): boolean {
      try {
        // Compute HMAC using raw body bytes directly
        // Secret can be either a string or Buffer (decoded from base64)
        const hmac = crypto
          .createHmac('sha256', secret)
          .update(body)
          .digest('base64');
        
        // Log for debugging (remove in production)
        console.log('Signature verification', {
          computedHmac: hmac,
          receivedSignature: signature,
          computedLength: hmac.length,
          receivedLength: signature.length,
          match: hmac === signature,
          bodyFirstBytes: body.slice(0, 50).toString('hex'),
          bodyLastBytes: body.slice(-50).toString('hex'),
        });
        
        // Both are base64 strings, compare directly using constant-time comparison
        const hmacBuffer = Buffer.from(hmac);
        const signatureBuffer = Buffer.from(signature);
        
        // Use constant-time comparison to prevent timing attacks
        if (hmacBuffer.length !== signatureBuffer.length) {
          return false;
        }
        
        return crypto.timingSafeEqual(hmacBuffer, signatureBuffer);
      } catch (error) {
        console.error('Error during signature verification:', error);
        return false;
      }
    }
  }