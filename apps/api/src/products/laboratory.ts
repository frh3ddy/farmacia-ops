import { PrismaClient } from '@prisma/client';

/** Find-or-create by name (case-insensitive), same pattern as findOrCreateActiveIngredient. */
export async function findOrCreateLaboratory(prisma: PrismaClient, name: string): Promise<string> {
  const trimmed = name.trim();
  const existing = await prisma.laboratory.findFirst({
    where: { name: { equals: trimmed, mode: 'insensitive' } },
  });
  if (existing) return existing.id;
  const created = await prisma.laboratory.create({ data: { name: trimmed } });
  return created.id;
}
