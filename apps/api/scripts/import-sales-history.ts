/**
 * One-time import of the stores' closed Square orders into SalesHistoryLine
 * (src/sales-history/sales-history.ts), for sales velocity and busy hours.
 * Only reads Square, and never touches FIFO, COGS or P&L. Stopped midway, it
 * resumes from the last order saved when run again.
 *
 * Usage:
 *   npm run import-sales-history -w apps/api            # dry run: counts what it would save
 *   npm run import-sales-history -w apps/api -- --yes   # saves
 * Against production, only when the owner says so:
 *   railway ssh --service api -- npm run import-sales-history -w apps/api -- --yes
 */
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { createSquareClient, squareEnvironment } from '../src/square/square-client';
import { importSalesHistory } from '../src/sales-history/sales-history';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL not set');
  const client = createSquareClient();
  if (!client) throw new Error('SQUARE_ACCESS_TOKEN not set');
  const save = process.argv.includes('--yes');
  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    console.log(`Square: ${squareEnvironment()} · DB host: ${new URL(connectionString).hostname} · ${save ? 'SAVING' : 'dry run'}`);
    const r = await importSalesHistory(prisma, client, { save });
    console.log(`Pages: ${r.pages} · orders: ${r.orders} · lines: ${r.lines} · saved: ${r.saved} · without a product: ${r.unmapped}`);
    if (!save) console.log('Dry run: nothing saved. Re-run with --yes to save.');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
