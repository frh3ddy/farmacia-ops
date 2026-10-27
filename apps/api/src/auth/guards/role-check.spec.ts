import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { assert } from 'riteway/vitest';
import { AuthGuard, ROLES_KEY } from './auth.guard';

// Every route of every controller in the api, with the roles and guards that
// apply to it (handler metadata, else the controller's).
const srcDir = join(__dirname, '../..');
const controllerFiles = (readdirSync(srcDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.controller.ts'));

type Route = { route: string; roles?: string[]; guards: Function[] };
let routes: Route[] = [];
let roleRoutes: Route[] = [];

beforeAll(async () => {
  const modules: Record<string, unknown>[] = await Promise.all(controllerFiles.map((f) => import(join(srcDir, f))));
  routes = modules
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
    );
  roleRoutes = routes.filter((r) => r.roles?.length);
});

/** `Controller.handler` for every handler that declares a RoleGuardedRequest parameter. */
function roleGuardedHandlers() {
  return controllerFiles.flatMap((f) => {
    const lines = readFileSync(join(srcDir, f), 'utf8').split('\n');
    const controller = lines.join('\n').match(/export class (\w+)/)?.[1];
    return lines.flatMap((line, i) => {
      if (!/: RoleGuardedRequest\b/.test(line)) return [];
      const signature = lines.slice(0, i + 1).reverse().find((l) => /^  (?:async )?\w+\(/.test(l));
      return [`${controller}.${signature?.match(/^  (?:async )?(\w+)\(/)?.[1]}`];
    });
  });
}

describe('role check', () => {
  test('routes restricted to roles', () => {
    assert({
      given: 'every route with @Roles',
      should: 'go through AuthGuard, which enforces the roles',
      actual: roleRoutes.filter((r) => !r.guards.includes(AuthGuard)).map((r) => r.route),
      expected: [],
    });
  });

  test('handlers typed as RoleGuardedRequest', () => {
    // RoleGuardedRequest promises a current location, which AuthGuard only
    // guarantees on @Roles routes; elsewhere it can be undefined and crash.
    const roleRouteNames = new Set(roleRoutes.map((r) => r.route));
    const handlers = roleGuardedHandlers();

    assert({
      given: 'every handler that declares a RoleGuardedRequest',
      should: 'be a @Roles route',
      actual: handlers.filter((h) => !roleRouteNames.has(h)),
      expected: [],
    });
    assert({
      given: 'the api source',
      should: 'find the RoleGuardedRequest handlers to check',
      actual: handlers.length > 0 && handlers.every((h) => routes.some((r) => r.route === h)),
      expected: true,
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
