/**
 * RxNav Provider -- prompt-drug-classification-service.md's "1. RxNav
 * Provider" section:
 *   1. GET /rxcui.json?name={drugName}&search=2       -> RxCUI
 *   2. GET /rxclass/class/byRxcui.json?rxcui=...&relaSource=ATC -> ATC class
 *
 * Extracted out of run-drug-classification-test.ts so other callers
 * (run-full-catalog-tiers-1-3.ts) reuse the same lookup instead of a second
 * copy. No API key needed.
 */
const RXNAV_BASE = 'https://rxnav.nlm.nih.gov/REST';

export interface AtcClass {
  classId: string;
  className: string;
}

export async function findRxcui(name: string): Promise<string | null> {
  const url = `${RXNAV_BASE}/rxcui.json?name=${encodeURIComponent(name)}&search=2`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const body = await res.json();
  const ids: string[] = body?.idGroup?.rxnormId || [];
  return ids[0] ?? null;
}

export async function findAtcClasses(rxcui: string): Promise<AtcClass[]> {
  const url = `${RXNAV_BASE}/rxclass/class/byRxcui.json?rxcui=${encodeURIComponent(rxcui)}&relaSource=ATC`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  const body = await res.json();
  const entries: any[] = body?.rxclassDrugInfoList?.rxclassDrugInfo || [];

  // Keep only classes attributed to the exact rxcui we queried (not related
  // combination products RxNav also returns alongside it), and dedupe.
  const seen = new Set<string>();
  const classes: AtcClass[] = [];
  for (const entry of entries) {
    if (entry?.minConcept?.rxcui !== rxcui) continue;
    const classId = entry?.rxclassMinConceptItem?.classId;
    const className = entry?.rxclassMinConceptItem?.className;
    if (!classId || seen.has(classId)) continue;
    seen.add(classId);
    classes.push({ classId, className });
  }
  return classes;
}
