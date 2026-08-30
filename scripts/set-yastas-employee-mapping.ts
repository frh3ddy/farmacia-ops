/**
 * Flags an already-synced Square catalog item as a per-employee Yastás IN
 * item: sets tracksInventory=false on its mapped Product and employeeId on
 * every CatalogMapping row for that variation (location-specific + global).
 * Run once per employee's catalog item, after `catalog sync` has created the
 * CatalogMapping row.
 *
 * Usage: npx tsx scripts/set-yastas-employee-mapping.ts --variation=<squareVariationId> --employee=<employeeId>
 */
import prisma from '../prisma/client';

function argValue(flag: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg?.split('=')[1];
}

async function main() {
  const squareVariationId = argValue('variation');
  const employeeId = argValue('employee');

  if (!squareVariationId || !employeeId) {
    console.error('Usage: npx tsx scripts/set-yastas-employee-mapping.ts --variation=<squareVariationId> --employee=<employeeId>');
    process.exit(1);
  }

  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) {
    console.error(`Employee ${employeeId} not found`);
    process.exit(1);
  }

  const mappings = await prisma.catalogMapping.findMany({ where: { squareVariationId } });
  if (mappings.length === 0) {
    console.error(`No CatalogMapping rows for variation ${squareVariationId} — run catalog sync first`);
    process.exit(1);
  }

  const productIds = [...new Set(mappings.map((m) => m.productId))];

  await prisma.$transaction(async (tx) => {
    await tx.catalogMapping.updateMany({
      where: { squareVariationId },
      data: { employeeId },
    });
    await tx.product.updateMany({
      where: { id: { in: productIds } },
      data: { tracksInventory: false },
    });
  });

  console.log(
    `Mapped variation ${squareVariationId} to employee ${employee.name} (${mappings.length} mapping row(s), ${productIds.length} product(s) flagged tracksInventory=false).`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
