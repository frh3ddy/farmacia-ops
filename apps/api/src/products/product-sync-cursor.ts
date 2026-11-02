/**
 * Where a phone's product sync is. Products are paged by (changeXid, id), the
 * transaction that last stamped each one (see the product_change_stamp
 * migration). A transaction still running while a page is read may commit a
 * stamp below the position already passed, so each page records the oldest
 * running transaction (the snapshot's xmin) and the walk keeps the lowest one:
 * the next walk resumes from that floor, re-sending a few rows rather than
 * missing one.
 */
import { BadRequestException } from '@nestjs/common';

export type SyncPosition = { xid: bigint; id: string };
export type SyncCursor = { after: SyncPosition; floor: bigint | null };

const FORMAT = /^(\d+):([A-Za-z0-9-]*):(\d*)$/;

export function parseSyncCursor(cursor: string | undefined): SyncCursor {
  if (!cursor) return { after: { xid: 0n, id: '' }, floor: null };
  const match = FORMAT.exec(cursor);
  if (!match) throw new BadRequestException('Cursor de sincronización inválido');
  const [, xid, id, floor] = match;
  return { after: { xid: BigInt(xid), id }, floor: floor ? BigInt(floor) : null };
}

/** The cursor after a page: the next page's start, or, on the last page, the next walk's. */
export function nextSyncCursor(
  cursor: SyncCursor,
  page: { snapshotXmin: bigint; last: SyncPosition | null; hasMore: boolean },
): string {
  const floor = cursor.floor !== null && cursor.floor < page.snapshotXmin ? cursor.floor : page.snapshotXmin;
  // An id of '' sorts before every id, so the next walk starts at the floor itself.
  return page.hasMore && page.last ? `${page.last.xid}:${page.last.id}:${floor}` : `${floor}::`;
}
