import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { assert } from 'riteway/vitest';
import { AllExceptionsFilter } from './all-exceptions.filter';

/** The warnings logged while the filter answers `exception` for a manager's GET /inventory/reports/cogs. */
function warningsFor(exception: unknown) {
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const request = {
    method: 'GET',
    path: '/inventory/reports/cogs',
    ip: '10.0.0.7',
    employee: { id: 'e1' },
    headers: { 'x-session-token': 'secret-session', authorization: 'Bearer secret-device' },
  };
  const response = { status: () => response, json: () => response };
  const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as any;

  new AllExceptionsFilter().catch(exception, host);
  const messages = warn.mock.calls.map(([message]) => String(message));
  warn.mockRestore();
  return messages;
}

const refused = (status: HttpStatus, message: string) => new HttpException({ success: false, message }, status);

describe('AllExceptionsFilter', () => {
  test('refused request', () => {
    // Regression: 403s were answered and forgotten, so probing other stores'
    // data or owner-only routes left no trace (OWASP A09).
    assert({
      given: 'a request refused with 403',
      should: 'log who asked for what, and why it was refused',
      actual: warningsFor(refused(HttpStatus.FORBIDDEN, 'Access denied to this location')),
      expected: ['[ACCESS] 403 GET /inventory/reports/cogs employee=e1 ip=10.0.0.7: Access denied to this location'],
    });
  });

  test('unauthenticated request', () => {
    const lines = warningsFor(refused(HttpStatus.UNAUTHORIZED, 'Invalid session'));

    assert({
      given: 'a request refused with 401',
      should: 'log it without the session or device token',
      actual: { logged: lines.length, leaksToken: lines.some((m) => m.includes('secret')) },
      expected: { logged: 1, leaksToken: false },
    });
  });

  test('locked out', () => {
    assert({
      given: 'a request refused with 429 by a login lockout',
      should: 'log it like any other refusal',
      actual: warningsFor(refused(HttpStatus.TOO_MANY_REQUESTS, 'Demasiados intentos fallidos. Intenta de nuevo en 15 minutos.')),
      expected: ['[ACCESS] 429 GET /inventory/reports/cogs employee=e1 ip=10.0.0.7: Demasiados intentos fallidos. Intenta de nuevo en 15 minutos.'],
    });
  });

  test('other errors', () => {
    assert({
      given: 'a request that fails with 400',
      should: 'not log an access warning',
      actual: warningsFor(refused(HttpStatus.BAD_REQUEST, 'quantity is required')),
      expected: [],
    });
  });
});
