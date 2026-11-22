/**
 * One-time cleanup (src/stock-alerts/dead-items.ts): pauses, per store, the
 * products at 0 not sold in over 2 years (or never), so Alertas starts from
 * what's worth a look. A dry run saves nothing: it prints counts per store and
 * writes dead-items.csv for the owner to skim.
 *
 * Usage:
 *   npm run pause-dead-items -w apps/api            # dry run
 *   npm run pause-dead-items -w apps/api -- --yes   # pauses them
 * Against production, only when the owner says so.
 */
import path from 'path';
import { writeFileSync } from 'fs';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { deadItems, pauseDeadItems } from '../src/stock-alerts/dead-items';

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL not set');
  const save = process.argv.includes('--yes');
  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    console.log(`DB host: ${new URL(connectionString).hostname} · ${save ? 'PAUSING' : 'dry run'}`);
    const rows: unknown[][] = [['store', 'productId', 'name', 'lastSoldAt', 'qty']];
    for (const store of await prisma.location.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } })) {
      // Saving, the list is what was paused.
      const items = save ? await pauseDeadItems(prisma, store.id) : await deadItems(prisma, store.id);
      const qty = new Map((await prisma.inventory.groupBy({
        by: ['productId'], where: { locationId: store.id, productId: { in: items.map((s) => s.product.id) } }, _sum: { quantity: true },
      })).map((g) => [g.productId, g._sum.quantity ?? 0]));
      for (const s of items) rows.push([store.name, s.product.id, s.product.name, s.lastSoldAt ?? 'never', qty.get(s.product.id) ?? 0]);
      console.log(`${store.name}: ${items.length} dead items${save ? ', paused' : ''}`);
    }
    const file = path.resolve(process.env.INIT_CWD ?? process.cwd(), 'dead-items.csv'); // where npm was run
    writeFileSync(file, rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
    console.log(`List: ${file}`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
