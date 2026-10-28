import { WebhooksHelper } from 'square';
import { assert } from 'riteway/vitest';
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

  test('refund events', async () => {
    process.env.SQUARE_WEBHOOK_SECRET = 'key';
    process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = 'https://example.test/webhooks/square';
    vi.mocked(WebhooksHelper.verifySignature).mockResolvedValue(true as never);
    const send = async (type: string, status: string) => {
      const saleQueue = { enqueue: vi.fn(), enqueueRefund: vi.fn().mockResolvedValue({ id: 'evt-r' }) };
      const res = { status: vi.fn().mockReturnThis(), send: vi.fn() };
      const event = { type, event_id: 'evt-r', data: { object: { refund: { id: 'rf-1', status } } } };
      await new SquareWebhookController(saleQueue as any).handle('sig', { rawBody: Buffer.from(JSON.stringify(event)) } as any, res as any);
      return { queued: saleQueue.enqueueRefund.mock.calls.length, sale: saleQueue.enqueue.mock.calls.length, reply: res.send.mock.calls[0]?.[0] };
    };

    assert({
      given: 'a completed refund, as refund.created or refund.updated',
      should: 'queue it for the worker (which records it once, whichever comes first)',
      actual: [await send('refund.created', 'COMPLETED'), await send('refund.updated', 'COMPLETED')],
      expected: [{ queued: 1, sale: 0, reply: 'Accepted' }, { queued: 1, sale: 0, reply: 'Accepted' }],
    });
    assert({
      given: 'a refund not completed yet',
      should: 'ignore it until Square reports it completed',
      actual: await send('refund.created', 'PENDING'),
      expected: { queued: 0, sale: 0, reply: 'Ignored' },
    });
  });
});
