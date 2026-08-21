import { PrismaClient, PharmaceuticalForm, AdministrationRoute } from '@prisma/client';

/** Find-or-create by name (case-insensitive), same pattern as Laboratory. */
export async function findOrCreateActiveIngredient(prisma: PrismaClient, name: string): Promise<string> {
  const trimmed = name.trim();
  const existing = await prisma.activeIngredient.findFirst({
    where: { name: { equals: trimmed, mode: 'insensitive' } },
  });
  if (existing) return existing.id;
  const created = await prisma.activeIngredient.create({ data: { name: trimmed } });
  return created.id;
}

export type MedicationDefinitionInput = {
  name: string;
  form: PharmaceuticalForm;
  route: AdministrationRoute;
  strength: string;
  activeIngredientIds: string[];
};

/**
 * A MedicationDefinition's real identity is (ingredient set, strength, form,
 * route) — not a single-column DB constraint, so this narrows candidates by
 * (form, route, strength) in SQL then compares the ingredient set in JS
 * before creating a new row.
 */
export async function findOrCreateMedicationDefinition(
  prisma: PrismaClient,
  input: MedicationDefinitionInput,
): Promise<string> {
  const wantedIngredients = [...input.activeIngredientIds].sort();

  const candidates = await prisma.medicationDefinition.findMany({
    where: { form: input.form, route: input.route, strength: input.strength },
    include: { ingredients: { select: { activeIngredientId: true } } },
  });

  for (const candidate of candidates) {
    const candidateIngredients = candidate.ingredients.map((i) => i.activeIngredientId).sort();
    if (
      candidateIngredients.length === wantedIngredients.length &&
      candidateIngredients.every((id, i) => id === wantedIngredients[i])
    ) {
      return candidate.id;
    }
  }

  const created = await prisma.medicationDefinition.create({
    data: {
      name: input.name,
      form: input.form,
      route: input.route,
      strength: input.strength,
      ingredients: {
        create: input.activeIngredientIds.map((activeIngredientId) => ({ activeIngredientId })),
      },
    },
  });
  return created.id;
}
