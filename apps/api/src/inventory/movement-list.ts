import { BadRequestException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

/**
 * Movement lists (receivings, adjustments) page newest first by time, then id,
 * so rows with the same time are neither skipped nor repeated across pages.
 * The cursor is the last row's time and id.
 */
export type MovementCursor = { at: Date; id: string };

export function parseMovementCursor(cursor: string | undefined): MovementCursor | undefined {
  if (!cursor) return undefined;
  const [ms, id] = Buffer.from(cursor, 'base64url').toString().split('_');
  const at = new Date(Number(ms));
  if (!id || !ms || Number.isNaN(at.getTime())) throw new BadRequestException('Invalid cursor');
  return { at, id };
}

/** The cursor for the page after `rows`, or null when it was the last (fewer rows than the limit). */
export function nextMovementCursor<K extends string>(rows: Array<{ id: string } & Record<K, Date>>, limit: number, atKey: K): string | null {
  const last = rows[limit - 1];
  return rows.length >= limit && last ? Buffer.from(`${last[atKey].getTime()}_${last.id}`).toString('base64url') : null;
}

/** Rows after the cursor, in (time desc, id desc) order. */
export function afterCursor<K extends string>(cursor: MovementCursor | undefined, atKey: K) {
  return cursor ? { OR: [{ [atKey]: { lt: cursor.at } }, { [atKey]: cursor.at, id: { lt: cursor.id } }] } : {};
}

/** Employee names by id; 'SYSTEM', null and unknown ids have none. */
export async function employeeNames(prisma: Pick<PrismaClient, 'employee'>, ids: Array<string | null>): Promise<(id: string | null) => string | null> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  const found = wanted.length ? await prisma.employee.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } }) : [];
  const names = new Map(found.map((e) => [e.id, e.name]));
  return (id) => (id && names.get(id)) || null;
}
