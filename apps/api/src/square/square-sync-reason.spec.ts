import { assert } from 'riteway/vitest';
import { squareSyncReason } from './square-sync-reason';

describe('squareSyncReason', () => {
  test('a store not linked to Square', () => {
    assert({
      given: 'the sync error "Location not linked to Square"',
      should: 'say so in Spanish',
      actual: squareSyncReason('Location not linked to Square'),
      expected: 'La tienda no está conectada a Square',
    });
  });

  test('a product missing from the Square catalog', () => {
    assert({
      given: 'the sync error Product not mapped to Square catalog',
      should: 'say what went wrong in Spanish',
      actual: squareSyncReason('Product not mapped to Square catalog'),
      expected: 'El producto no está en el catálogo de Square',
    });
  });

  test('a store Square does not know', () => {
    // As stored by the local API on 2026-10-31 for a store missing from Square.
    const raw = 'Status code: 404\nBody: {\n  "errors": [\n    {\n      "category": "INVALID_REQUEST_ERROR",\n      "code": "NOT_FOUND",\n      "detail": "This merchant does not have a location with the ID `TEST-LOC-2`."\n    }\n  ]\n}';
    assert({
      given: "Square's raw 404 for an unknown location",
      should: 'say Square does not recognise the store, without the raw body',
      actual: squareSyncReason(raw),
      expected: 'Square no reconoce esta tienda',
    });
  });

  test('Square not reachable', () => {
    assert({
      given: 'a network failure ("fetch failed") or a timeout',
      should: 'say Square could not be reached and to retry later',
      actual: [squareSyncReason('fetch failed'), squareSyncReason('The operation was aborted due to timeout')],
      expected: Array(2).fill('No se pudo conectar con Square; reintenta más tarde'),
    });
  });

  test('Square not configured, or any other error', () => {
    assert({
      given: '"Square client not configured", an unrecognised Square error, or no error text',
      should: 'give a short Spanish reason and never the raw text',
      actual: [
        squareSyncReason('Square client not configured'),
        squareSyncReason('Status code: 400\nBody: { "errors": [ { "code": "INVALID_VALUE" } ] }'),
        squareSyncReason(undefined),
      ],
      expected: ['Square no está configurado', 'Square rechazó el cambio', 'Square rechazó el cambio'],
    });
  });
});
