import { Injectable, OnModuleInit } from '@nestjs/common';
import { stripAccents } from '../inventory-migration/category-classifier';
import { PrismaService } from '../prisma/prisma.service';
import referenceData from './pharmacy-reference-data.json';

export type PresentacionEntry = { forma: string; envase: string; concentraciones: string[] };
type ProductoEntry = {
  principio_activo: string;
  marcas: string[];
  vias_administracion: string[];
  presentaciones: PresentacionEntry[];
};
type CategoryEntry = { sintomas: string[]; productos: ProductoEntry[] };
const DATA = referenceData as Record<string, CategoryEntry>;

export type BrandSuggestion = { brand: string; category: string; ingredients: string[] };
export type IngredientSuggestion = {
  ingredient: string;
  brands: string[];
  category: string;
  viasAdministracion: string[];
  presentaciones: PresentacionEntry[];
};

const BRAND_INDEX: BrandSuggestion[] = [];
// Keyed by normalized principio_activo — one row per ingredient (the new
// dataset already de-duplicates ingredients across categories, unlike the
// old flat marcas/principios_activos arrays it replaced).
const INGREDIENT_INDEX = new Map<string, IngredientSuggestion & { key: string }>();

// One row per (brand, ingredient) pair — same shape/consumers as before
// (AddProductScreen's suggestByBrandName), just sourced from
// productos[].marcas instead of a flat per-category list.
for (const [category, entry] of Object.entries(DATA)) {
  for (const producto of entry.productos) {
    for (const brand of producto.marcas) {
      BRAND_INDEX.push({ brand, category, ingredients: [producto.principio_activo] });
    }
    const key = stripAccents(producto.principio_activo.toLowerCase());
    INGREDIENT_INDEX.set(key, {
      key,
      ingredient: producto.principio_activo,
      brands: producto.marcas,
      category,
      viasAdministracion: producto.vias_administracion,
      presentaciones: producto.presentaciones,
    });
  }
}

// Reviewer-confirmed ingredient names that weren't in the static dataset —
// see LearnedIngredient in schema.prisma. Grown at runtime by
// InventoryMigrationService.approveItem() and reloaded here on boot, so a
// name a reviewer typed/confirmed once is recognized by findIngredientInText
// (and therefore by parseProductName's structural-guess path) on every
// future cutover, not just future requests within the same process.
// Intentionally shaped like a real dataset entry but with empty
// presentaciones/viasAdministracion/brands — parseProductName reads that
// emptiness as "no canonical data, still LOW confidence, still worth a
// name-match" rather than treating it the same as a fully-known drug.
export function addLearnedIngredient(name: string): void {
  const key = stripAccents(name.toLowerCase());
  if (INGREDIENT_INDEX.has(key)) return;
  INGREDIENT_INDEX.set(key, { key, ingredient: name, brands: [], category: 'Medicina', viasAdministracion: [], presentaciones: [] });
}

const MAX_SUGGESTIONS = 8;

// "ac" is the single most common Spanish pharmacy abbreviation for "ácido"
// (e.g. Square catalog names write "Amoxicilina ac Clavulánico" with no "/",
// vs. the reference dataset's "amoxicilina/ácido clavulánico") — normalizing
// just this one abbreviation, rather than a general abbreviation dictionary,
// is enough to match the common compound-ingredient case without guessing.
export function normalizeForIngredientMatch(s: string): string {
  return stripAccents(s.toLowerCase())
    .replace(/\//g, ' ')
    .replace(/\bac\.?\b/g, 'acido')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plain (non-DI) lookup so the pure product-name-parser can call it without
 * NestJS wiring. Picks the LONGEST matching ingredient key contained in
 * `rawText` (substring match, same philosophy as suggestByIngredient/
 * catalog-search.ts — no fuzzy/scored matching) so a compound ingredient
 * like "amoxicilina/ácido clavulánico" wins over the plain "amoxicilina"
 * it also contains. */
export function findIngredientInText(rawText: string): IngredientSuggestion | null {
  const normalizedText = normalizeForIngredientMatch(rawText);
  let best: IngredientSuggestion | null = null;
  let bestKeyLength = 0;
  for (const entry of INGREDIENT_INDEX.values()) {
    const key = normalizeForIngredientMatch(entry.ingredient);
    if (key.length > bestKeyLength && normalizedText.includes(key)) {
      best = entry;
      bestKeyLength = key.length;
    }
  }
  return best;
}

/**
 * Suggestion-only lookups over the static Mexican-pharmacy reference dataset
 * (apps/api/src/products/pharmacy-reference-data.json) — brand<->ingredient
 * associations are many-to-many across categories (e.g. ibuprofeno appears
 * under both Analgésicos and Antiinflamatorios), so a match can legitimately
 * return several candidates. Used to power AddProductScreen autocomplete and
 * the cutover name parser's ingredient/form/route/concentration resolution;
 * never authoritative — the real ActiveIngredient/MedicationDefinition
 * records are what actually get persisted.
 */
@Injectable()
export class ReferenceDataService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    const learned = await this.prisma.learnedIngredient.findMany({ select: { name: true } });
    for (const { name } of learned) addLearnedIngredient(name);
  }

  suggestByBrandName(query: string): BrandSuggestion[] {
    const normalized = stripAccents(query.trim().toLowerCase());
    if (normalized.length < 2) return [];
    return BRAND_INDEX.filter((b) => stripAccents(b.brand.toLowerCase()).includes(normalized)).slice(0, MAX_SUGGESTIONS);
  }

  suggestByIngredient(query: string): IngredientSuggestion[] {
    const normalized = stripAccents(query.trim().toLowerCase());
    if (normalized.length < 2) return [];
    const results: IngredientSuggestion[] = [];
    for (const [key, entry] of INGREDIENT_INDEX) {
      if (key.includes(normalized)) results.push(entry);
    }
    return results.slice(0, MAX_SUGGESTIONS);
  }
}
