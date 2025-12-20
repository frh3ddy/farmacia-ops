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
    // Get signature from headers - Square uses x-square-hmacsha256-signature
    // Check both possible header names
    const hmacSignatureHeader = req.headers['x-square-hmacsha256-signature'];
    const squareSignatureHeader = req.headers['x-square-signature'];
    const signatureHeader = hmacSignatureHeader || squareSignatureHeader;
    
    console.log('Signature headers', {
      hasXSquareHmacsha256Signature: !!hmacSignatureHeader,
      hasXSquareSignature: !!squareSignatureHeader,
      allHeaders: Object.keys(req.headers).filter(h => h.toLowerCase().includes('square') || h.toLowerCase().includes('signature')),
    });
    
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
    });
    
    // Square's webhook signature key - use as-is (Square provides it in this format)
    // Verify signature using raw body bytes directly
    const verificationPassed = this.verifySignature(rawBody, signature, webhookSecret);
  
    if (!verificationPassed) {
      console.error('❌ Signature verification failed', {
        signatureReceived: signature,
        signatureLength: signature.length,
        bodyLength: rawBody.length,
        bodyPreview: bodyString.substring(0, 100),
        secretLength: webhookSecret.length,
        secretPreview: webhookSecret.substring(0, 10) + '...',
      });
      console.error('');
      console.error('🔍 TROUBLESHOOTING:');
      console.error('1. Verify you are using the Webhook Signature Key (not Application Secret)');
      console.error('   - Go to: Square Developer Dashboard → Your App → Webhooks');
      console.error('   - Copy the "Signature Key" (should be a long base64 string)');
      console.error('   - Make sure you are using the key for the correct environment (Sandbox vs Production)');
      console.error('2. The secret should be base64-encoded (only A-Z, a-z, 0-9, +, /, = characters)');
      console.error('3. Verify the SQUARE_WEBHOOK_SECRET environment variable is set correctly in Railway');
      console.error('');
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
  
    private verifySignature(body: Buffer, signature: string, secret: string): boolean {
      try {
        // Try multiple approaches to see which one works
        // Approach 1: Use raw body bytes (current)
        const hmac1 = crypto
          .createHmac('sha256', secret)
          .update(body)
          .digest('base64');
        
        // Approach 2: Use body as UTF-8 string (in case Square uses string)
        const bodyString = body.toString('utf8');
        const hmac2 = crypto
          .createHmac('sha256', secret)
          .update(bodyString, 'utf8')
          .digest('base64');
        
        // Log for debugging
        const match1 = hmac1 === signature;
        const match2 = hmac2 === signature;
        
        console.log('Signature verification attempts', {
          approach1_rawBytes: {
            computedHmac: hmac1,
            match: match1,
          },
          approach2_utf8String: {
            computedHmac: hmac2,
            match: match2,
          },
          receivedSignature: signature,
          bodyLength: body.length,
          bodyStringLength: bodyString.length,
        });
        
        // Try both approaches and use whichever matches
        let hmac: string;
        let matches: boolean;
        
        if (match1) {
          hmac = hmac1;
          matches = true;
          console.log('✅ Signature verification PASSED using raw bytes approach');
        } else if (match2) {
          hmac = hmac2;
          matches = true;
          console.log('✅ Signature verification PASSED using UTF-8 string approach');
        } else {
          // Use raw bytes approach for comparison (standard)
          hmac = hmac1;
          const hmacBuffer = Buffer.from(hmac);
          const signatureBuffer = Buffer.from(signature);
          
          // Use constant-time comparison to prevent timing attacks
          if (hmacBuffer.length !== signatureBuffer.length) {
            console.error('Signature length mismatch', {
              computedLength: hmacBuffer.length,
              receivedLength: signatureBuffer.length,
            });
            return false;
          }
          
          matches = crypto.timingSafeEqual(hmacBuffer, signatureBuffer);
          if (!matches) {
            console.error('❌ Signature mismatch - computed and received signatures do not match');
          }
        }
        
        return matches;
      } catch (error) {
        console.error('Error during signature verification:', error);
        return false;
      }
    }
  }