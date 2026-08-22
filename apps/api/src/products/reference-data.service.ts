import { Injectable } from '@nestjs/common';
import { stripAccents } from '../inventory-migration/category-classifier';
import referenceData from './pharmacy-reference-data.json';

type CategoryEntry = { sintomas: string[]; marcas: string[]; principios_activos: string[] };
const DATA = referenceData as Record<string, CategoryEntry>;

export type BrandSuggestion = { brand: string; category: string; ingredients: string[] };
export type IngredientSuggestion = { ingredient: string; brands: string[] };

const BRAND_INDEX: BrandSuggestion[] = [];
const INGREDIENT_INDEX = new Map<string, { label: string; brands: Set<string> }>();

for (const [category, entry] of Object.entries(DATA)) {
  for (const brand of entry.marcas) {
    BRAND_INDEX.push({ brand, category, ingredients: entry.principios_activos });
  }
  for (const ingredient of entry.principios_activos) {
    const key = stripAccents(ingredient.toLowerCase());
    const existing = INGREDIENT_INDEX.get(key) ?? { label: ingredient, brands: new Set<string>() };
    for (const brand of entry.marcas) existing.brands.add(brand);
    INGREDIENT_INDEX.set(key, existing);
  }
}

const MAX_SUGGESTIONS = 8;

/**
 * Suggestion-only lookups over the static Mexican-pharmacy reference dataset
 * (apps/api/src/products/pharmacy-reference-data.json) — brand<->ingredient
 * associations are many-to-many across categories (e.g. ibuprofeno appears
 * under both Analgésicos and Antiinflamatorios), so a match can legitimately
 * return several candidates. Used only to power AddProductScreen autocomplete;
 * never authoritative — the real ActiveIngredient/MedicationDefinition records
 * are what actually get persisted.
 */
@Injectable()
export class ReferenceDataService {
  suggestByBrandName(query: string): BrandSuggestion[] {
    const normalized = stripAccents(query.trim().toLowerCase());
    if (normalized.length < 2) return [];
    return BRAND_INDEX.filter((b) => stripAccents(b.brand.toLowerCase()).includes(normalized)).slice(0, MAX_SUGGESTIONS);
  }

  suggestByIngredient(query: string): IngredientSuggestion[] {
    const normalized = stripAccents(query.trim().toLowerCase());
    if (normalized.length < 2) return [];
    const results: IngredientSuggestion[] = [];
    for (const [key, { label, brands }] of INGREDIENT_INDEX) {
      if (key.includes(normalized)) results.push({ ingredient: label, brands: [...brands] });
    }
    return results.slice(0, MAX_SUGGESTIONS);
  }
}
