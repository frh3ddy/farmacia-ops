/**
 * One-time, per-location go-live cutover for the Yastás wallet: seeds a
 * YastasWallet with the pharmacy's actual current Yastás balance (read from
 * the Yastás portal, not estimated) and records the single OPENING_BALANCE
 * WalletMovement for it. Refuses to run twice for the same location — at
 * most one OPENING_BALANCE movement per wallet, ever.
 *
 * Usage: npx tsx scripts/seed-yastas-opening-balance.ts --location=<locationId> --amount=<n>
 */
import prisma from '../prisma/client';

function argValue(flag: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg?.split('=')[1];
}

async function main() {
  const locationId = argValue('location');
  const amountStr = argValue('amount');

  if (!locationId || !amountStr) {
    console.error('Usage: npx tsx scripts/seed-yastas-opening-balance.ts --location=<locationId> --amount=<n>');
    process.exit(1);
  }

  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount < 0) {
    console.error(`Invalid --amount: ${amountStr}`);
    process.exit(1);
  }

  const location = await prisma.location.findUnique({ where: { id: locationId } });
  if (!location) {
    console.error(`Location ${locationId} not found`);
    process.exit(1);
  }

  const existingWallet = await prisma.yastasWallet.findUnique({ where: { locationId } });
  if (existingWallet) {
    const existingOpening = await prisma.walletMovement.findFirst({
      where: { walletId: existingWallet.id, type: 'OPENING_BALANCE' },
    });
    if (existingOpening) {
      console.error(
        `Location ${location.name} already has an OPENING_BALANCE movement (${existingOpening.id}) — refusing to seed a second one.`,
      );
      process.exit(1);
    }
  }

  await prisma.$transaction(async (tx) => {
    const wallet = await tx.yastasWallet.upsert({
      where: { locationId },
      create: { locationId, balance: amount },
      update: { balance: amount },
    });
    await tx.walletMovement.create({
      data: { walletId: wallet.id, type: 'OPENING_BALANCE', amount },
    });
  });

  console.log(`Seeded YastasWallet opening balance for ${location.name}: $${amount}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
