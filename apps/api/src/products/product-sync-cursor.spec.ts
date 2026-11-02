import { assert } from 'riteway/vitest';
import { BadRequestException } from '@nestjs/common';
import { nextSyncCursor, parseSyncCursor } from './product-sync-cursor';

describe('parseSyncCursor', () => {
  test('no cursor', () => {
    assert({
      given: 'no cursor',
      should: 'start before every stamp, with no floor yet',
      actual: parseSyncCursor(undefined),
      expected: { after: { xid: 0n, id: '' }, floor: null },
    });
  });

  test('a cursor it handed out', () => {
    const cursor = nextSyncCursor(parseSyncCursor(undefined), { snapshotXmin: 90n, last: { xid: 95n, id: 'p-7' }, hasMore: true });

    assert({
      given: 'a cursor from a page with more to come',
      should: 'read back the same position and floor',
      actual: parseSyncCursor(cursor),
      expected: { after: { xid: 95n, id: 'p-7' }, floor: 90n },
    });
  });

  test('a cursor that is not one', () => {
    const error = (() => {
      try {
        parseSyncCursor('95:p-7;DROP');
      } catch (e) {
        return e;
      }
    })();

    assert({
      given: 'a malformed cursor',
      should: 'refuse it in Spanish',
      actual: error instanceof BadRequestException && error.message,
      expected: 'Cursor de sincronización inválido',
    });
  });
});

describe('nextSyncCursor', () => {
  const start = parseSyncCursor(undefined);

  test('a walk over several pages', () => {
    const page1 = parseSyncCursor(nextSyncCursor(start, { snapshotXmin: 90n, last: { xid: 95n, id: 'a' }, hasMore: true }));
    const page2 = parseSyncCursor(nextSyncCursor(page1, { snapshotXmin: 120n, last: { xid: 130n, id: 'b' }, hasMore: true }));

    assert({
      given: 'a later page whose oldest running transaction is newer',
      should: 'keep the lowest floor seen across the walk',
      actual: page2.floor,
      expected: 90n,
    });
  });

  test('the last page of a walk', () => {
    const page1 = parseSyncCursor(nextSyncCursor(start, { snapshotXmin: 90n, last: { xid: 95n, id: 'a' }, hasMore: true }));
    const done = parseSyncCursor(nextSyncCursor(page1, { snapshotXmin: 140n, last: { xid: 150n, id: 'c' }, hasMore: false }));

    assert({
      given: 'the last page',
      should: 'resume the next walk from the floor, so a transaction running during this walk is sent next time',
      actual: done,
      expected: { after: { xid: 90n, id: '' }, floor: null },
    });
  });

  test('an empty last page', () => {
    const done = parseSyncCursor(nextSyncCursor(start, { snapshotXmin: 200n, last: null, hasMore: false }));

    assert({
      given: 'nothing changed',
      should: 'resume from the oldest transaction still running',
      actual: done.after,
      expected: { xid: 200n, id: '' },
    });
  });
});
