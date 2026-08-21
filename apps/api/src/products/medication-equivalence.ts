/**
 * Pure equivalence logic: two products are equivalent alternatives iff they
 * share a medicationDefinitionId. A MedicationDefinition is itself defined by
 * exact ingredient set + strength + form + route (see schema.prisma), so
 * "different strength/form/route" is never treated as equivalent — that rule
 * is enforced by construction, not by a comparator here.
 *
 * No DB access in this file so it's directly unit-testable (see
 * scripts/test-medication-equivalence.ts). medication-equivalence.service.ts
 * is the thin Prisma wrapper around it.
 */

export type EquivalenceCandidate = {
  id: string;
  medicationDefinitionId: string | null;
  isDiscontinued: boolean;
  inStock: boolean;
  price: number | null;
};

/** Rank a product's alternatives: in-stock first, then cheapest first. */
export function rankEquivalents(
  product: { id: string; medicationDefinitionId: string | null },
  candidates: EquivalenceCandidate[],
): EquivalenceCandidate[] {
  if (!product.medicationDefinitionId) return [];

  return candidates
    .filter(
      (c) =>
        c.id !== product.id &&
        c.medicationDefinitionId === product.medicationDefinitionId &&
        !c.isDiscontinued,
    )
    .sort((a, b) => {
      if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
      const priceA = a.price ?? Infinity;
      const priceB = b.price ?? Infinity;
      return priceA - priceB;
    });
}
