import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { assert } from 'riteway/vitest';
import { assertLocationAccess, scopedLocationId } from './auth.guard';

const srcDir = join(__dirname, '../..');
const controllerFiles = (readdirSync(srcDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.controller.ts'));

// Type checks: npm test runs tsc, which fails if any of these compile.
export function locationHelperMisuses() {
  // @ts-expect-error misspelled request field
  assertLocationAccess({ currentLocaton: undefined, accessibleLocations: [] }, 'centro');
  // @ts-expect-error not a request
  scopedLocationId('centro');
}

describe('guarded request type', () => {
  test('controller handlers', () => {
    // Regression: handlers took `req: any`, so a typo like req.currentLocaton
    // compiled and read undefined (e.g. silently dropping location scoping).
    assert({
      given: 'every controller handler that reads the request',
      should: 'type it instead of using any',
      actual: controllerFiles.filter((f) => /@Req\(\) \w+: any\b/.test(readFileSync(join(srcDir, f), 'utf8'))),
      expected: [],
    });
  });
});
