import { readdirSync } from 'fs';
import { join } from 'path';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { assert } from 'riteway/vitest';
import { AuthGuard, ROLES_KEY } from './auth.guard';

// Every route of every controller in the api, with the roles and guards that
// apply to it (handler metadata, else the controller's).
const srcDir = join(__dirname, '../..');
const controllerFiles = (readdirSync(srcDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.controller.ts'));

type Route = { route: string; roles?: string[]; guards: Function[] };
let roleRoutes: Route[] = [];

beforeAll(async () => {
  const modules: Record<string, unknown>[] = await Promise.all(controllerFiles.map((f) => import(join(srcDir, f))));
  roleRoutes = modules
    .flatMap((exports) => Object.values(exports))
    .filter((value): value is Function => typeof value === 'function' && Reflect.getMetadata(PATH_METADATA, value) !== undefined)
    .flatMap((controller) =>
      Object.getOwnPropertyNames(controller.prototype)
        .filter((name) => name !== 'constructor' && Reflect.getMetadata(PATH_METADATA, controller.prototype[name]) !== undefined)
        .map((name) => {
          const handler = controller.prototype[name];
          return {
            route: `${controller.name}.${name}`,
            roles: Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, controller),
            guards: [...(Reflect.getMetadata(GUARDS_METADATA, controller) ?? []), ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])],
          };
        }),
    )
    .filter((r) => r.roles?.length);
});

describe('role check', () => {
  test('routes restricted to roles', () => {
    assert({
      given: 'every route with @Roles',
      should: 'go through AuthGuard, which enforces the roles',
      actual: roleRoutes.filter((r) => !r.guards.includes(AuthGuard)).map((r) => r.route),
      expected: [],
    });
  });

  test('roles checked once', () => {
    assert({
      given: 'every route with @Roles',
      should: 'check the roles in AuthGuard only, not again in a second guard',
      actual: roleRoutes.filter((r) => r.guards.some((g) => g.name === 'RoleGuard')).map((r) => r.route),
      expected: [],
    });
  });

  test('controllers found', () => {
    assert({
      given: 'the api source',
      should: 'find the role-restricted routes to check',
      actual: roleRoutes.length > 50,
      expected: true,
    });
  });
});
