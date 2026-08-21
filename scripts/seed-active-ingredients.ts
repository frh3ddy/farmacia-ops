/**
 * Seed a starter list of common OTC active ingredients (with aliases) so the
 * medication catalog isn't demoed from empty. Aliases are stored lowercase,
 * accent-stripped — that's the normalized form catalog-search.service.ts
 * compares against.
 *
 * Idempotent: find-or-create by name, safe to re-run.
 *
 * Usage: npx tsx scripts/seed-active-ingredients.ts
 */
import prisma from '../prisma/client';
import { findOrCreateActiveIngredient } from '../apps/api/src/products/medication-definition';

const INGREDIENTS: Record<string, string[]> = {
  Paracetamol: ['acetaminofen', 'acetaminofén'],
  Ibuprofeno: [],
  'Ácido acetilsalicílico': ['aspirina'],
  Naproxeno: [],
  Loratadina: [],
  Cetirizina: [],
  Omeprazol: [],
  Ranitidina: [],
  Loperamida: [],
  Amoxicilina: [],
  Metformina: [],
  Losartán: [],
  Simvastatina: [],
  Diclofenaco: [],
  Dextrometorfano: [],
};

async function main() {
  let created = 0;
  for (const [name, aliases] of Object.entries(INGREDIENTS)) {
    const id = await findOrCreateActiveIngredient(prisma, name);
    if (aliases.length > 0) {
      await prisma.activeIngredient.update({ where: { id }, data: { aliases } });
    }
    created++;
  }
  console.log(`Seeded ${created} active ingredients (idempotent — re-run anytime).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
