import { assert } from 'riteway/vitest';
import { WorkerSecretGuard } from './worker-secret.guard';

/** The guard's answer for a request with these headers while the api's secret is `configured`. */
async function verdict(headers: Record<string, string>, configured: string | undefined) {
  const before = process.env.WORKER_API_SECRET;
  if (configured === undefined) delete process.env.WORKER_API_SECRET;
  else process.env.WORKER_API_SECRET = configured;
  const context = { switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as any;
  try {
    return await Promise.resolve().then(() => new WorkerSecretGuard().canActivate(context)).then(() => 'allowed', (e: any) => e.getStatus?.() ?? e.message);
  } finally {
    if (before === undefined) delete process.env.WORKER_API_SECRET;
    else process.env.WORKER_API_SECRET = before;
  }
}

const secret = 'a'.repeat(64);

describe('WorkerSecretGuard', () => {
  test('the worker with the right secret', async () => {
    assert({
      given: 'the configured secret in x-worker-secret',
      should: 'let the call through',
      actual: await verdict({ 'x-worker-secret': secret }, secret),
      expected: 'allowed',
    });
  });

  test('a missing, wrong or different-length secret', async () => {
    assert({
      given: 'no secret, a wrong one of the same length, a shorter one, and a staff session token',
      should: 'refuse each with 401, never a 500',
      actual: [
        await verdict({}, secret),
        await verdict({ 'x-worker-secret': 'b'.repeat(64) }, secret),
        await verdict({ 'x-worker-secret': 'a' }, secret),
        await verdict({ authorization: 'Bearer some-session-token' }, secret),
      ],
      expected: [401, 401, 401, 401],
    });
  });

  test('no secret configured on the api', async () => {
    assert({
      given: 'the api started without WORKER_API_SECRET, or with it empty',
      should: 'refuse every call, even one sending an empty secret',
      actual: [await verdict({ 'x-worker-secret': '' }, undefined), await verdict({ 'x-worker-secret': '' }, ''), await verdict({}, undefined)],
      expected: [401, 401, 401],
    });
  });
});
