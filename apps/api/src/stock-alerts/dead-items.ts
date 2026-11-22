import type { PrismaClient } from '@prisma/client';
import { pauseSuggestions, type PauseSuggestion } from './pause-suggestions';
import { pauseProducts } from './stock-pause';

const DEAD_AFTER_DAYS = 730;

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
 * Pauses a store's dead items as slow movers through the pause path (a later
 * receiving resumes one), 200 at a time, telling `onPaused` after each; returns those it paused. Paused ones aren't
 * suggested, so a re-run pauses only what is left.
 */
export async function pauseDeadItems(
  prisma: PrismaClient,
  locationId: string,
  { now = new Date(), onPaused = () => {} }: { now?: Date; onPaused?: (chunk: PauseSuggestion[]) => void | Promise<void> } = {},
): Promise<PauseSuggestion[]> {
  const items = await deadItems(prisma, locationId, { now });
  for (let i = 0; i < items.length; i += 200) {
    const chunk = items.slice(i, i + 200);
    await pauseProducts(prisma, { productIds: chunk.map((s) => s.product.id), locationId, reason: 'SLOW_MOVER' });
    await onPaused(chunk);
  }
  return items;
}
