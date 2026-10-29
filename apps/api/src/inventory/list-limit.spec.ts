import { assert } from 'riteway/vitest';
import { listLimit, MAX_LIST_LIMIT } from './list-limit';

describe('listLimit', () => {
  test('requested page sizes', () => {
    assert({
      given: 'a missing, zero, negative, NaN, normal and huge limit',
      should: 'use the default unless the limit is positive, and cap it',
      actual: [undefined, 0, -5, NaN, 20, 100_000].map((limit) => listLimit(limit)),
      expected: [100, 100, 100, 100, 20, MAX_LIST_LIMIT],
    });
  });
});
