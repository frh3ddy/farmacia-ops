import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { assert } from 'riteway/vitest';
import { NotInProduction } from './not-in-production.guard';
import { SalesTestController } from '../../webhooks/square.controller';
import { DataController } from '../../data/data.controller';

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

const guardsOf = (target: object) => Reflect.getMetadata(GUARDS_METADATA, target) ?? [];
const blocked = (method: keyof DataController) => guardsOf(DataController.prototype[method]).includes(NotInProduction);

describe('dev tools in production', () => {
  test('production', () => {
    assert({
      given: 'the production environment',
      should: 'refuse, saying the tool would change real data',
      actual: attempt('production'),
      expected: 'Disabled in production: this dev tool changes real stock, cost or sales.',
    });
  });

  test('other environments', () => {
    assert({
      given: 'staging or a local run',
      should: 'allow the dev tools',
      actual: [attempt('staging'), attempt(undefined)],
      expected: [true, true],
    });
  });

  test('every test-sale route', () => {
    assert({
      given: 'the test-sale controller',
      should: 'apply the production block to all of its routes',
      actual: guardsOf(SalesTestController).includes(NotInProduction),
      expected: true,
    });
  });

  test('test inventory and resets', () => {
    assert({
      given: 'test inventory, catalog cleanup and full wipe',
      should: 'apply the production block to each',
      actual: [blocked('createTestInventory'), blocked('cleanupCatalog'), blocked('wipeFullDatabase')],
      expected: [true, true, true],
    });
  });

  test('read routes', () => {
    assert({
      given: 'the data read routes',
      should: 'stay available in production',
      actual: [blocked('getInventory'), guardsOf(DataController).includes(NotInProduction)],
      expected: [false, false],
    });
  });
});
