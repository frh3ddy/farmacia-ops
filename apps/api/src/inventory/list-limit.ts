export const MAX_LIST_LIMIT = 500;

/** A list's page size: the requested limit capped at MAX_LIST_LIMIT, or the default when missing or not positive. */
export function listLimit(limit: number | undefined, fallback = 100): number {
  return limit !== undefined && limit > 0 ? Math.min(limit, MAX_LIST_LIMIT) : fallback;
}
