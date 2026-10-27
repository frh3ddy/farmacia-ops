import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { assert } from 'riteway/vitest';
import { NotInProduction, SalesTestController } from './square.controller';

const attempt = (environment: string | undefined) => {
  vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', environment);
  try {
    return new NotInProduction().canActivate();
  } catch (error) {
    return error instanceof ForbiddenException ? error.message : error;
  } finally {
    vi.unstubAllEnvs();
  }
};

describe('test sales', () => {
  test('production', () => {
    assert({
      given: 'the production environment',
      should: 'refuse test sales, which would write real sales and take real stock',
      actual: attempt('production'),
      expected: 'Test sales are disabled in production: they record real sales and consume real stock.',
    });
  });

  test('other environments', () => {
    assert({
      given: 'staging or a local run',
      should: 'allow test sales',
      actual: [attempt('staging'), attempt(undefined)],
      expected: [true, true],
    });
  });

  test('every test-sale route', () => {
    assert({
      given: 'the test-sale controller',
      should: 'apply the production block to all of its routes',
      actual: (Reflect.getMetadata(GUARDS_METADATA, SalesTestController) ?? []).includes(NotInProduction),
      expected: true,
    });
  });
});
