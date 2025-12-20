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
        bodyValue: req.body,
      });
      return res.status(HttpStatus.BAD_REQUEST).send('Invalid request body');
    }
    
    // Log body details for debugging
    const bodyString = rawBody.toString('utf8');
    console.log('Raw body details', {
      bodyLength: rawBody.length,
      bodyStringLength: bodyString.length,
      bodyFirst100Chars: bodyString.substring(0, 100),
      bodyLast100Chars: bodyString.substring(bodyString.length - 100),
      bodyHash: crypto.createHash('sha256').update(rawBody).digest('hex'),
    });
    
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
    
    // Log secret details (first/last few chars only for security)
    console.log('Webhook secret details', {
      secretLength: webhookSecret.length,
      secretFirst5: webhookSecret.substring(0, 5),
      secretLast5: webhookSecret.substring(webhookSecret.length - 5),
      isBase64Like: /^[A-Za-z0-9+/=]+$/.test(webhookSecret),
    });
    
    // Square's webhook signature key - try both decoded and as-is
    // Some Square implementations use base64-decoded key, others use it as-is
    let verificationPassed = false;
    
    // Try with base64-decoded secret first
    try {
      const decodedSecret = Buffer.from(webhookSecret, 'base64');
      console.log('Trying signature verification with decoded secret', {
        originalLength: webhookSecret.length,
        decodedLength: decodedSecret.length,
      });
      verificationPassed = this.verifySignature(rawBody, signature, decodedSecret, 'decoded');
    } catch (error) {
      console.log('Failed to decode secret, trying as-is', error);
    }
    
    // If decoded didn't work, try with secret as-is
    if (!verificationPassed) {
      console.log('Trying signature verification with secret as-is', {
        secretLength: webhookSecret.length,
      });
      verificationPassed = this.verifySignature(rawBody, signature, webhookSecret, 'as-is');
    }
  
    // Verify signature using raw body bytes directly (not string conversion)
    if (!verificationPassed) {
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
  
    private verifySignature(body: Buffer, signature: string, secret: string | Buffer, method: string = 'unknown'): boolean {
      try {
        // Compute HMAC using raw body bytes directly
        // Secret can be either a string or Buffer (decoded from base64)
        const hmac = crypto
          .createHmac('sha256', secret)
          .update(body)
          .digest('base64');
        
        // Log for debugging (remove in production)
        console.log(`Signature verification (${method})`, {
          computedHmac: hmac,
          receivedSignature: signature,
          computedLength: hmac.length,
          receivedLength: signature.length,
          match: hmac === signature,
        });
        
        // Both are base64 strings, compare directly using constant-time comparison
        const hmacBuffer = Buffer.from(hmac);
        const signatureBuffer = Buffer.from(signature);
        
        // Use constant-time comparison to prevent timing attacks
        if (hmacBuffer.length !== signatureBuffer.length) {
          return false;
        }
        
        const matches = crypto.timingSafeEqual(hmacBuffer, signatureBuffer);
        if (matches) {
          console.log(`✅ Signature verification PASSED using ${method} method`);
        }
        return matches;
      } catch (error) {
        console.error(`Error during signature verification (${method}):`, error);
        return false;
      }
    }
  }