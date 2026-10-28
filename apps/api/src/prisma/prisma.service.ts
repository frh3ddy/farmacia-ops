import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    // Explicit pool sizing — otherwise pg's default (max: 10) applies
    // silently and is shared across every concurrent request this service
    // handles. Tunable via env so it can be raised alongside traffic without
    // a code change; connectionTimeoutMillis makes pool exhaustion fail
    // fast with a clear error instead of requests queuing indefinitely.
    const pool = new Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_MAX) || 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // An idle connection dropped by the server (restart, failover) emits
    // 'error' on the pool; unhandled, it crashes the api. The pool replaces
    // the connection on the next query.
    const logger = new Logger(PrismaService.name);
    pool.on('error', (error) => logger.error(`Idle database connection lost: ${error.message}`));
    const adapter = new PrismaPg(pool);

    super({ adapter });
    this.pool = pool;
  }

  async onModuleInit() {
    // Optional: Test connection on module init
  }

  async onModuleDestroy() {
    await this.$disconnect();
    // The adapter was handed this pool, so $disconnect leaves it open.
    await this.pool.end();
  }
}


