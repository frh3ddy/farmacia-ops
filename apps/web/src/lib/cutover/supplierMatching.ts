import { apiFetch } from "../apiFetch";
import type { Supplier, SupplierSuggestion } from "./types";

export type SupplierNameMapping = { supplierOriginal: string; new: string };

/**
 * One canonical implementation. The legacy wizard had this exact matching
 * logic (initial match → exact name → local rename mapping → partial name)
 * duplicated in both utils/supplierUtils.jsx and hooks/useSupplierMatching.jsx,
 * byte-for-byte identical apart from how they threaded state setters through.
 */
export function getSupplierSuggestions(
  inputValue: string,
  allSuppliers: Supplier[],
  supplierNameMappings: SupplierNameMapping[]
): SupplierSuggestion[] {
  if (!inputValue || inputValue.trim().length === 0) return [];

  const searchTerm = inputValue.trim().toLowerCase();
  const suggestions: SupplierSuggestion[] = [];

  const initialMatches: SupplierSuggestion[] = allSuppliers
    .filter(s => s.isActive && s.initials.some(init => init.toLowerCase() === searchTerm))
    .map(s => ({ id: s.id, name: s.name, contactInfo: s.contactInfo, matchType: "initial", isExactMatch: true }));
  suggestions.push(...initialMatches);

  const exactNameMatches: SupplierSuggestion[] = allSuppliers
    .filter(s => s.isActive && s.name.toLowerCase() === searchTerm)
    .map(s => ({ id: s.id, name: s.name, contactInfo: s.contactInfo, matchType: "name" as const, isExactMatch: true }))
    .filter(s => !suggestions.some(existing => existing.id === s.id));
  suggestions.push(...exactNameMatches);

  const mappingMatches: SupplierSuggestion[] = supplierNameMappings
    .filter(m => m.supplierOriginal.toLowerCase() === searchTerm || m.new.toLowerCase() === searchTerm)
    .map((m): SupplierSuggestion => {
      const supplier = allSuppliers.find(s => s.name === m.new);
      if (supplier && supplier.isActive) {
        return { id: supplier.id, name: supplier.name, contactInfo: supplier.contactInfo, matchType: "mapping", isExactMatch: true };
      }
      return { id: null, name: m.new, contactInfo: null, matchType: "mapping", isExactMatch: true };
    })
    .filter((s, index, self) => index === self.findIndex(t => t.name === s.name));
  suggestions.push(...mappingMatches);

  if (suggestions.length === 0) {
    const nameMatches: SupplierSuggestion[] = allSuppliers
      .filter(s => s.isActive && s.name.toLowerCase().includes(searchTerm))
      .map(s => ({ id: s.id, name: s.name, contactInfo: s.contactInfo, matchType: "name" as const, isExactMatch: false }))
      .filter(s => !suggestions.some(existing => existing.name === s.name));
    suggestions.push(...nameMatches);
  }

  return suggestions.slice(0, 10);
}

/** Exactly one exact-match suggestion → the caller can auto-fill without
 * asking. Returns null when the input is ambiguous or has no exact match. */
export function findAutoSelectMatch(
  inputValue: string,
  allSuppliers: Supplier[],
  supplierNameMappings: SupplierNameMapping[]
): SupplierSuggestion | null {
  const suggestions = getSupplierSuggestions(inputValue, allSuppliers, supplierNameMappings);
  const exactMatches = suggestions.filter(s => s.isExactMatch);
  return exactMatches.length === 1 ? exactMatches[0] : null;
}

/** Remote fallback (POST-DB-query suggestions) used when the local
 * allSuppliers list has no match — same `/suppliers/suggest` endpoint the
 * legacy autocomplete inputs called inline four separate times. */
export async function suggestSuppliersRemote(query: string): Promise<SupplierSuggestion[]> {
  if (query.trim().length <= 1) return [];
  try {
    const body = await apiFetch<{ suppliers: SupplierSuggestion[] }>(
      `/admin/inventory/cutover/suppliers/suggest?q=${encodeURIComponent(query)}`
    );
    return body.suppliers;
  } catch {
    return [];
  }
}

export function matchSupplierByInitialOrName(
  originalSupplierName: string | null | undefined,
  allSuppliers: Supplier[],
  supplierNameMappings: SupplierNameMapping[]
): { name: string | null; id: string | null; matchedByInitial: boolean } {
  if (!originalSupplierName || originalSupplierName === "Unknown" || originalSupplierName === "General") {
    return { name: null, id: null, matchedByInitial: false };
  }

  const term = originalSupplierName.trim().toLowerCase();
  const byInitial = allSuppliers.find(s => s.isActive && s.initials.some(init => init.toLowerCase() === term));
  if (byInitial) return { name: byInitial.name, id: byInitial.id, matchedByInitial: true };

  const byName = allSuppliers.find(s => s.isActive && s.name.toLowerCase() === term);
  if (byName) return { name: byName.name, id: byName.id, matchedByInitial: false };

  const mapping = supplierNameMappings.find(m => m.supplierOriginal === originalSupplierName);
  if (mapping) {
    const mapped = allSuppliers.find(s => s.isActive && s.name === mapping.new);
    return { name: mapping.new, id: mapped?.id ?? null, matchedByInitial: false };
  }

  return { name: null, id: null, matchedByInitial: false };
}
