/**
 * Typo-tolerant product search for GET /products?search= (iOS product list,
 * web transfers/break-bulk pickers). Pure: query in, Prisma.Sql out, so it is
 * unit-testable without a DB (product-search.spec.ts).
 *
 * Two tiers, cheapest first:
 *   1. every token is a substring of the product's normalized search text —
 *      index-backed (LIKE '%t%' hits "Product_search_trgm_idx"), covers the
 *      normal no-typo case including out-of-order tokens ("ibupro 400").
 *   2. only when tier 1 finds nothing: pg_trgm word_similarity per token,
 *      which survives a wrong/missing character ("parasetamol").
 * Tier 2 cannot use the index (function form, not the `%>` operator, so no
 * dependency on the pg_trgm.word_similarity_threshold GUC) — it is a seq scan
 * over Product, which is why it only runs on the rare miss.
 */
import { Prisma } from '@prisma/client';
import { stripAccents } from '../inventory-migration/category-classifier';

/** Below 4 chars a word has too few trigrams for similarity to mean anything. */
const MIN_FUZZY_TOKEN_LENGTH = 4;
/** One substituted character in an 8-11 char word scores ~0.6; 0.45 leaves room for two. */
const WORD_SIMILARITY_THRESHOLD = 0.45;
/** ponytail: a 7th token is a paste accident, not a search. */
const MAX_TOKENS = 6;
/** Search is top-of-list, not a browse — nobody pages to result 501. */
const MAX_RESULTS = 500;

/** Must stay in sync with product_search_text() in the DB (see the migration). */
export function normalizeQuery(query: string): string {
  return stripAccents(query.toLowerCase()).trim();
}

/**
 * Order-independent tokens: "Gel Frío 100ml" -> ["gel", "frio", "100", "ml"].
 * A strength glued to its unit is split so "500mg" also finds "500 mg";
 * letter-led codes ("IB400") stay whole.
 */
export function searchTokens(query: string): string[] {
  return normalizeQuery(query)
    .split(/[^a-z0-9]+/)
    .flatMap((t) => /^(\d+)([a-z]+)$/.exec(t)?.slice(1) ?? [t])
    .filter((t) => t.length > 0)
    .slice(0, MAX_TOKENS);
}

const isNumeric = (token: string) => /^\d/.test(token);

// Repeated inline (not via a CTE or alias) because the planner only matches a
// GIN expression index when the query contains the identical expression.
const HAY = Prisma.sql`product_search_text(p.name, p."squareProductName", p.sku)`;

/**
 * Something sellable before something that isn't — as a tie-break only, after
 * relevance, so a weaker match never jumps a stronger one. "In stock" is the
 * sum of the product's FIFO batches at `locationId` (every location when none
 * is given), the same figure getProducts reports as totalInventory; batches
 * can net to zero. Items that don't track inventory (Yastás services) never
 * have batches and are always available. Correlated per matched row, so it
 * costs one `Inventory_productId_idx` lookup per match, not a table scan.
 */
function availableFirstSql(locationId?: string): Prisma.Sql {
  const atLocation = locationId ? Prisma.sql`AND i."locationId" = ${locationId}` : Prisma.empty;
  return Prisma.sql`(NOT p."tracksInventory" OR COALESCE(
      (SELECT SUM(i.quantity) FROM "Inventory" i WHERE i."productId" = p.id ${atLocation}), 0) > 0) DESC`;
}

/**
 * Relevance, highest first: exact SKU, then name-starts-with, then the whole
 * query appearing verbatim; ties go to what's in stock, then the shortest name
 * (a bare "Tylenol" outranks "Tylenol Infantil Jarabe 120ml" for "tylenol").
 */
function rankSql(query: string, locationId?: string): Prisma.Sql {
  return Prisma.sql`
    (CASE WHEN translate(lower(COALESCE(p.sku, '')), 'áéíóúñü', 'aeiounu') = ${query} THEN 1000 ELSE 0 END
     + CASE WHEN ${HAY} LIKE ${`${query}%`} THEN 500 ELSE 0 END
     + CASE WHEN ${HAY} LIKE ${`%${query}%`} THEN 300 ELSE 0 END) DESC,
    ${availableFirstSql(locationId)},
    length(p.name) ASC, p.name ASC`;
}

/**
 * One token present in the haystack. A number has to start where a number
 * starts — "500" must not hit "1500 ml" or the middle of barcode 7501500,
 * which would surface the wrong strength. Left boundary only, so a
 * half-typed "50" still finds "500 mg". Both forms are trigram-indexable.
 */
function tokenMatchSql(token: string): Prisma.Sql {
  return isNumeric(token)
    ? Prisma.sql`${HAY} ~ ${`(^|[^0-9])${token}`}`
    : Prisma.sql`${HAY} LIKE ${`%${token}%`}`;
}

/** Tier 1: all tokens present, in any order. */
export function substringMatchSql(tokens: string[], query: string, locationId?: string): Prisma.Sql {
  const conditions = tokens.map(tokenMatchSql);
  return Prisma.sql`
    SELECT p.id FROM "Product" p
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY ${rankSql(query, locationId)}
    LIMIT ${MAX_RESULTS}`;
}

/**
 * Tier 2: same, but each long-enough word may instead be a near-miss.
 * Numbers never are: 1600 is a different strength, not a typo of 1500.
 */
export function fuzzyMatchSql(tokens: string[], query: string, locationId?: string): Prisma.Sql {
  const conditions = tokens.map((t) =>
    t.length >= MIN_FUZZY_TOKEN_LENGTH && !isNumeric(t)
      ? Prisma.sql`(${tokenMatchSql(t)} OR word_similarity(${t}, ${HAY}) >= ${WORD_SIMILARITY_THRESHOLD})`
      : tokenMatchSql(t),
  );
  return Prisma.sql`
    SELECT p.id FROM "Product" p
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY word_similarity(${query}, ${HAY}) DESC, ${availableFirstSql(locationId)}, length(p.name) ASC, p.name ASC
    LIMIT ${MAX_RESULTS}`;
}

/** Runs a built query — `prisma.$queryRaw` in the service, PGlite in tests. */
export type RunQuery = (sql: Prisma.Sql) => Promise<{ id: string }[]>;

/**
 * Product ids matching a free-text search, best first (ties: in stock at
 * `locationId` first). Tries the indexed substring tier and only pays for
 * trigram similarity when that finds nothing, so a typo costs one extra query
 * and a clean query costs none.
 */
export async function findSearchMatchIds(search: string, run: RunQuery, locationId?: string): Promise<string[]> {
  const tokens = searchTokens(search);
  if (tokens.length === 0) return [];
  const query = normalizeQuery(search);

  let rows = await run(substringMatchSql(tokens, query, locationId));
  if (rows.length === 0) rows = await run(fuzzyMatchSql(tokens, query, locationId));
  return rows.map((r) => r.id);
}

/** Restore the SQL relevance order after Prisma re-fetches the rows by id. */
export function sortByIdOrder<T extends { id: string }>(rows: T[], ids: string[]): T[] {
  const position = new Map(ids.map((id, i) => [id, i]));
  return [...rows].sort((a, b) => (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity));
}
