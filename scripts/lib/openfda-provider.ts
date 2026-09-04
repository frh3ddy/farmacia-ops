/**
 * OpenFDA Provider — prompt-drug-classification-service.md's "2. OpenFDA
 * Provider" section, generic-name lookup only (this repo's catalog is
 * mostly generics; brand/NDC/UPC search can be added the same way if
 * needed later). No API key required.
 *
 * Coverage caveat: OpenFDA only knows about US-marketed drugs. A Mexican
 * generic (e.g. amoxicillin) often resolves fine since the substance is
 * sold in the US too, under a different labeler; a Mexico-only combination
 * product usually won't resolve here at all -- that's expected, not a bug.
 */
const OPENFDA_BASE = 'https://api.fda.gov/drug';

export interface OpenFdaResult {
  /**
   * CAUTION: for a common generic name this is one arbitrary match out of
   * (often hundreds of) unrelated US manufacturers selling the same active
   * ingredient -- NOT necessarily anything to do with the actual product's
   * real manufacturer. Only treat as reasonably representative when
   * totalMatches is small. Never present as equivalent to a verified
   * COFEPRIS/registry-sourced laboratorio.
   */
  laboratorio: string | null;
  ndc: string | null;
  upc_barcode: string | null;
  dosage_form: string | null;
  route: string[] | null;
  totalMatches: number; // how many US NDC listings matched -- the returned one is just the first
}

export async function searchOpenFdaByGenericName(name: string): Promise<OpenFdaResult | null> {
  const url = `${OPENFDA_BASE}/ndc.json?search=generic_name:${encodeURIComponent(`"${name}"`)}&limit=1`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null; // openFDA returns 404 (not an error body) when nothing matches

  const body = await res.json();
  const result = body?.results?.[0];
  if (!result) return null;

  return {
    laboratorio: result.labeler_name ?? null,
    ndc: result.product_ndc ?? null,
    upc_barcode: result.openfda?.upc?.[0] ?? null,
    dosage_form: result.dosage_form ?? null,
    route: result.route ?? null,
    totalMatches: body?.meta?.results?.total ?? 1,
  };
}
