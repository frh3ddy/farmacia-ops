/**
 * A real Postgres engine (PGlite) with every migration applied, served over a
 * socket so the real PrismaService can connect. For *.pg.spec.ts suites.
 *
 * PGlite is a single connection, so transactions can't interleave: test a
 * race's guards here, not the race itself.
 */
import { readdirSync, readFileSync } from 'fs';
import { createServer } from 'net';
import { join } from 'path';
import { PGlite, type Extension } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaService } from '../prisma/prisma.service';

// The migrations need pg_trgm. tsconfig's module resolution can't see package
// `exports` subpaths (see product-search.pg.spec.ts), so require it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm') as { pg_trgm: Extension };

const MIGRATIONS = join(__dirname, '../../../../prisma/migrations');

/** A bare engine with the migrations applied in order, those before `before` only when given (to test a migration's data step). */
export async function migratedDb({ before }: { before?: string } = {}) {
  const db = await PGlite.create({ extensions: { pg_trgm } });
  for (const dir of readdirSync(MIGRATIONS).filter((d) => !d.endsWith('.toml') && (!before || d < before)).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
  }
  return db;
}

/** Runs one migration by its folder name. */
export const applyMigration = (db: PGlite, name: string) => db.exec(readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8'));

export async function startPostgres() {
  const db = await migratedDb();
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port });
  await server.start();

  vi.stubEnv('DATABASE_URL', `postgresql://postgres@127.0.0.1:${port}/postgres`);
  vi.stubEnv('DATABASE_POOL_MAX', '1');
  const prisma = new PrismaService();

  const stop = async () => {
    await prisma.onModuleDestroy();
    await server.stop();
    await db.close();
    vi.unstubAllEnvs();
  };
  return { prisma, stop };
}

/** A port the OS says is free. A random pick from a fixed range let parallel suites collide (EADDRINUSE). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}
