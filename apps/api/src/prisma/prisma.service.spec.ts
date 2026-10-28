import { assert } from 'riteway/vitest';
import { PrismaService } from './prisma.service';

// Nothing listens on this port; neither test opens a connection.
const serviceWithPool = () => {
  process.env.DATABASE_URL = 'postgresql://postgres@127.0.0.1:1/none';
  const service = new PrismaService();
  return { service, pool: service['pool'] };
};

describe('PrismaService', () => {
  test('shutting down', async () => {
    const { service, pool } = serviceWithPool();
    await service.onModuleDestroy();

    assert({
      given: 'the module being destroyed',
      should: 'end the connection pool too ($disconnect leaves a pool it was handed open)',
      actual: pool.ended,
      expected: true,
    });
  });

  test('an idle connection dropped by the database', () => {
    const { pool } = serviceWithPool();
    let crashed = false;
    try {
      // What pg does when the server closes an idle client (restart, failover).
      pool.emit('error', new Error('Connection terminated unexpectedly'));
    } catch {
      crashed = true;
    }

    assert({
      given: 'the pool reporting a lost idle connection',
      should: 'handle it instead of crashing the process',
      actual: crashed,
      expected: false,
    });
  });
});
