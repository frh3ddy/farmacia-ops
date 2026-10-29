import { assert } from 'riteway/vitest';
import { SquareEnvironment } from 'square';
import { squareEnvironment } from './square-client';

const { Sandbox, Production } = SquareEnvironment;

describe('squareEnvironment', () => {
  test('which Square account a deploy talks to', () => {
    assert({
      given: 'production settings, then each sandbox signal on its own, even next to SQUARE_ENVIRONMENT=production',
      should: 'use production only when no sandbox signal is present',
      actual: [
        {},
        { SQUARE_ENVIRONMENT: 'production', NODE_ENV: 'production', RAILWAY_ENVIRONMENT: 'production' },
        { SQUARE_ENVIRONMENT: 'Sandbox' },
        { SQUARE_ENVIRONMENT: 'production', NODE_ENV: 'development' },
        { SQUARE_ENVIRONMENT: 'production', NODE_ENV: 'dev' },
        { SQUARE_ENVIRONMENT: 'production', RAILWAY_ENVIRONMENT: 'staging' },
        { SQUARE_ENVIRONMENT: 'production', RAILWAY_ENVIRONMENT: 'development' },
      ].map((env) => squareEnvironment(env as NodeJS.ProcessEnv)),
      expected: [Production, Production, Sandbox, Sandbox, Sandbox, Sandbox, Sandbox],
    });
  });
});
