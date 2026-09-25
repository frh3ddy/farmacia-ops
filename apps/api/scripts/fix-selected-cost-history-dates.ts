/**
 * One-off repair for cutover approvals made before the review editor started
 * giving the selected supplier entry the newest date (ExtractionItemEditor's
 * giveSelectedLatestDate). Approval writes every entry as a MIGRATION
 * SupplierCostHistory row at its date, and cost history is read newest-first,
 * so an older pick reads as superseded by a supplier that wasn't chosen.
 *
 * Per product: the preferred supplier's current MIGRATION row takes the
 * newest date among that approval's MIGRATION rows, and the rows that were
 * newer shift down one slot. Same set of dates — nothing invented. Costs,
 * isCurrent, Inventory/FIFO are untouched.
 *
 * Usage:
 *   npm run fix-selected-cost-history-dates            # dry run: lists affected products
 *   npm run fix-selected-cost-history-dates -- --yes   # applies (non-localhost also needs --force)
 */
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// ponytail: an approval writes its rows in one transaction, seconds apart at
// most; rows further than this from the current row belong to an earlier
// (superseded) approval and are left alone. Widen if an approval ever spans longer.
const SAME_APPROVAL_WINDOW_MS = 60_000;

type Row = { id: string; supplierId: string; effectiveAt: Date; createdAt: Date; isCurrent: boolean };

/** Returns id → new effectiveAt for rows whose date changes; empty if already correct. */
function rotate(rows: Row[], selectedId: string): Map<string, Date> {
  const sorted = [...rows].sort(
    (a, b) => a.effectiveAt.getTime() - b.effectiveAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const dates = sorted.map((r) => r.effectiveAt);
  const selected = sorted.find((r) => r.id === selectedId)!;
  if (selected.effectiveAt.getTime() === dates[dates.length - 1].getTime()) return new Map();
  const order = sorted.filter((r) => r.id !== selectedId).concat(selected);
  const changes = new Map<string, Date>();
  order.forEach((r, i) => {
    if (r.effectiveAt.getTime() !== dates[i].getTime()) changes.set(r.id, dates[i]);
  });
  return changes;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL not set');

  const host = new URL(connectionString).hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  const apply = process.argv.includes('--yes');
  if (apply && !isLocal && !process.argv.includes('--force')) {
    console.error(`Refusing to write: DATABASE_URL host is "${host}", not localhost. Pass --force if you really mean it.`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const preferred = await prisma.supplierProduct.findMany({
    where: { isPreferred: true },
    select: { productId: true, supplierId: true, product: { select: { name: true } } },
  });
  const byProduct = new Map<string, typeof preferred>();
  for (const p of preferred) byProduct.set(p.productId, [...(byProduct.get(p.productId) ?? []), p]);

  const rowsByProduct = new Map<string, Row[]>();
  for (const r of await prisma.supplierCostHistory.findMany({
    where: { source: 'MIGRATION', productId: { in: [...byProduct.keys()] } },
    select: { id: true, productId: true, supplierId: true, effectiveAt: true, createdAt: true, isCurrent: true },
  })) {
    rowsByProduct.set(r.productId, [...(rowsByProduct.get(r.productId) ?? []), r]);
  }

  const updates: Array<{ id: string; effectiveAt: Date }> = [];
  let affected = 0;
  let skipped = 0;
  for (const [productId, prefs] of byProduct) {
    const rows = rowsByProduct.get(productId) ?? [];
    const currents = prefs.length === 1 ? rows.filter((r) => r.supplierId === prefs[0].supplierId && r.isCurrent) : [];
    if (currents.length !== 1) {
      if (rows.length > 0) skipped++;
      continue;
    }
    const selected = currents[0];
    const approvalRows = rows.filter(
      (r) => Math.abs(r.createdAt.getTime() - selected.createdAt.getTime()) <= SAME_APPROVAL_WINDOW_MS,
    );
    const changes = rotate(approvalRows, selected.id);
    if (changes.size === 0) continue;
    affected++;
    const day = (d: Date) => d.toISOString().split('T')[0];
    console.log(`${prefs[0].product.name} (${productId})`);
    for (const r of approvalRows) {
      const next = changes.get(r.id);
      if (next) console.log(`  ${r.id === selected.id ? '*' : ' '} ${day(r.effectiveAt)} → ${day(next)}`);
      if (next) updates.push({ id: r.id, effectiveAt: next });
    }
  }

  console.log(`\n${affected} product(s) to fix, ${updates.length} row(s) to update; ${skipped} skipped (no single preferred supplier with one current row).`);

  if (!apply) {
    console.log(`Dry run against ${host} — pass --yes to apply.`);
  } else if (updates.length > 0) {
    await prisma.$transaction(
      updates.map((u) => prisma.supplierCostHistory.update({ where: { id: u.id }, data: { effectiveAt: u.effectiveAt } })),
      // One round trip per row over Railway's public proxy blows the 5s default.
      { timeout: 120_000 },
    );
    console.log(`Applied against ${host}.`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('FAILED, transaction rolled back:', e);
  process.exit(1);
});
