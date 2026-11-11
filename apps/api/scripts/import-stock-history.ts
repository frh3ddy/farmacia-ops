/**
 * One-time rebuild of StockDay (src/stock-alerts/stock-history-import.ts):
 * Square's inventory changes before each store's cutover, the app's movements
 * after. Only reads Square. A dry run prints the report the owner reads first:
 * per store, how many Square items replay to Square's current count, and the
 * worst mismatches.
 *
 * Usage:
 *   npm run import-stock-history -w apps/api            # dry run: the report, nothing saved
 *   npm run import-stock-history -w apps/api -- --yes   # saves (replaces stored days)
 * Against production, only when the owner says so:
 *   railway ssh --service api -- npm run import-stock-history -w apps/api
 */
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { createSquareClient, squareEnvironment } from '../src/square/square-client';
import { importStockHistory } from '../src/stock-alerts/stock-history-import';

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
    const r = await importStockHistory(prisma, client, { save });
    for (const s of r.stores) {
      console.log(`\n${s.store} (cutover ${s.cutoverDay ?? 'none'}): ${s.matching} of ${s.items} items replay to Square's count (${(s.matchingShare * 100).toFixed(1)}%); ${s.unmapped} items without a product left out`);
      for (const w of s.worst) console.log(`  ${w.difference > 0 ? '+' : ''}${w.difference}\treplay ${w.replay} · Square ${w.square}\t${w.product}`);
    }
    const types = Object.entries(r.unreadable.byType).map(([t, n]) => `${t} ${n}`).join(', ');
    console.log(`\nSquare changes the replay couldn't place: ${r.unreadable.total}${types ? ` (${types})` : ''}. Many means the history is incomplete.`);
    console.log(`Products under more than one Square item: ${r.multiItemProducts} · day rows: ${r.rows} · saved: ${r.saved}`);
    console.log(
      "Reading a mismatch: the replay runs to today, and since the cutover Square's count also reflects what the app sent it." +
        ' A store change that failed to reach Square (shown in the app\'s history as not synced) is a mismatch the replay didn\'t cause.',
    );
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
