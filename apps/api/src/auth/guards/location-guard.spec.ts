import { assert } from 'riteway/vitest';
import { LocationGuard } from './auth.guard';

// A manager assigned only to "centro".
function managerRequest(parts: { params?: object; query?: object; body?: object }) {
  return {
    params: {},
    query: {},
    body: {},
    ...parts,
    currentLocation: { role: 'MANAGER', locationId: 'centro' },
    accessibleLocations: [{ locationId: 'centro', isActive: true }],
  };
}

const contextFor = (request: object) => ({ switchToHttp: () => ({ getRequest: () => request }) }) as any;

/** 'allowed', or the refusal's message. */
const outcome = (request: object) =>
  new LocationGuard().canActivate(contextFor(request)).then(() => 'allowed', (e: Error) => e.message);

describe('LocationGuard', () => {
  test('own location', async () => {
    assert({
      given: 'a manager asking for the location they are assigned to',
      should: 'allow the request',
      actual: await outcome(managerRequest({ query: { locationId: 'centro' } })),
      expected: 'allowed',
    });
  });

  test('no location sent', async () => {
    assert({
      given: 'a request that names no location',
      should: 'allow it and leave scoping to the controller (scopedLocationId)',
      actual: await outcome(managerRequest({})),
      expected: 'allowed',
    });
  });

  test('another location in the path', async () => {
    assert({
      given: 'a manager naming another location in the URL path',
      should: 'refuse the request',
      actual: await outcome(managerRequest({ params: { locationId: 'norte' } })),
      expected: 'Access denied to this location',
    });
  });

  test('another location sent alongside an allowed one', async () => {
    // Regression: only the first of params/query/body was checked, so an
    // allowed ?locationId= let a different body.locationId through.
    assert({
      given: 'a manager sending their own location in the query and another in the body',
      should: 'refuse the request',
      actual: await outcome(managerRequest({ query: { locationId: 'centro' }, body: { locationId: 'norte' } })),
      expected: 'Access denied to this location',
    });
  });
});
