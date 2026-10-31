/**
 * The short Spanish reason shown to users when a stock change didn't sync to
 * Square. `raw` is the sync error as stored on the record (`squareSyncError`):
 * a known message from the sync code, or the Square SDK's error with its body.
 * The raw error stays on the record and in the log for diagnosis.
 */
export function squareSyncReason(raw: string | undefined | null): string {
  if (raw === 'Square client not configured') return 'Square no está configurado';
  if (raw === 'Location not linked to Square') return 'La tienda no está conectada a Square';
  if (raw === 'Product not mapped to Square catalog') return 'El producto no está en el catálogo de Square';
  if (raw && /NOT_FOUND/.test(raw) && /location/i.test(raw)) return 'Square no reconoce esta tienda';
  if (raw && /fetch failed|timeout|timed out|ECONN|ENOTFOUND|socket/i.test(raw)) {
    return 'No se pudo conectar con Square; reintenta más tarde';
  }
  return 'Square rechazó el cambio';
}

/** A sync outcome as the API sends it: the short reason in place of the raw error. */
export function readableSync<T extends { synced: boolean; error?: string | null }>(sync: T): T {
  return sync.synced ? sync : { ...sync, error: squareSyncReason(sync.error) };
}

/** The end of a success message for a change that may not have reached Square. */
export function squareSyncNote(sync: { synced: boolean; error?: string | null } | null | undefined): string {
  if (!sync) return '';
  return sync.synced
    ? ' (sincronizado con Square)'
    : ` — no se sincronizó con Square: ${squareSyncReason(sync.error)}. Puedes reintentar desde el historial.`;
}
