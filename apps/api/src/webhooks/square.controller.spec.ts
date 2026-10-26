import { WebhooksHelper } from 'square';
import { SquareWebhookController } from './square.controller';

vi.mock('square', () => ({ WebhooksHelper: { verifySignature: vi.fn() } }));

describe('SquareWebhookController', () => {
  // Regression: an in-memory "pause" switch (meant for test webhooks) also
  // applied here, answering 200 to real sales without enqueueing them — Square
  // never retries a 200, so those sales were lost.
  it('always enqueues a verified payment.created event', async () => {
    process.env.SQUARE_WEBHOOK_SECRET = 'key';
    process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = 'https://example.test/webhooks/square';
    vi.mocked(WebhooksHelper.verifySignature).mockResolvedValue(true as never);
    const saleQueue = { enqueue: vi.fn().mockResolvedValue({ id: 'evt-1' }) };
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn() };
    const event = { type: 'payment.created', event_id: 'evt-1', data: {} };

    await new SquareWebhookController(saleQueue as any).handle(
      'sig',
      { rawBody: Buffer.from(JSON.stringify(event)) } as any,
      res as any,
    );

    expect(saleQueue.enqueue).toHaveBeenCalledWith(event);
    expect(res.send).toHaveBeenCalledWith('Accepted');
  });
});
