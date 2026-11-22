import type { PrismaClient } from '@prisma/client';
import { pauseSuggestions, type PauseSuggestion } from './pause-suggestions';
import { pauseProducts } from './stock-pause';
import { businessDay } from '../inventory/business-date';

const DEAD_AFTER_DAYS = 730;
const CHUNK = 50;
// Run from a laptop through the DB proxy, an upsert is ~0.4 s (several ~110 ms round trips): 50 need ~20 s, over Prisma's 5 s default (2026-11-21).
const TIMEOUT_MS = 120_000;

/**
 * A store's dead items, for the one-time cleanup (Fredy, 2026-11-21): its
 * NO_SALES_AT_ZERO suggestions last sold over 2 years ago, or never.
 */
export async function deadItems(prisma: PrismaClient, locationId: string, { now = new Date() }: { now?: Date } = {}): Promise<PauseSuggestion[]> {
  const cutoff = now.getTime() - DEAD_AFTER_DAYS * 86_400_000;
  const isDead = (s: PauseSuggestion) => s.kind === 'NO_SALES_AT_ZERO' && (!s.lastSoldAt || new Date(s.lastSoldAt).getTime() < cutoff);
  const found: PauseSuggestion[] = [];
  for (let page = 1; ; page++) {
    const { data, totalCount, limit } = await pauseSuggestions(prisma, locationId, { page, limit: 200, now });
    found.push(...data.filter(isDead));
    if (page * limit >= totalCount) return found;
  }
}

/**
 * Pauses a store's dead items as slow movers noted "Limpieza <store's day>" through the pause path (a later
 * receiving resumes one), CHUNK at a time, telling `onPaused` after each; returns those it paused. Paused ones aren't
 * suggested, so a re-run pauses only what is left.
 */
export async function pauseDeadItems(
  prisma: PrismaClient,
  locationId: string,
  { now = new Date(), onPaused = () => {}, timeout = TIMEOUT_MS }: { now?: Date; onPaused?: (chunk: PauseSuggestion[]) => void | Promise<void>; timeout?: number } = {},
): Promise<PauseSuggestion[]> {
  const items = await deadItems(prisma, locationId, { now });
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    await pauseProducts(prisma, { productIds: chunk.map((s) => s.product.id), locationId, reason: 'SLOW_MOVER', note: `Limpieza ${businessDay(now)}` }, { timeout });
    await onPaused(chunk);
  }
  return items;
}
