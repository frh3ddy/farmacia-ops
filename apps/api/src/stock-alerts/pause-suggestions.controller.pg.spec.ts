/**
 * The pause-suggestion routes and the Alertas count (see testing/pglite.ts).
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { ROLES_KEY } from '../auth/guards/auth.guard';
import { ProductsController } from '../products/products.controller';
import { ProductsService } from '../products/products.service';
import { PauseSuggestionsController } from './pause-suggestions.controller';

let prisma: PrismaService;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
}, 120_000);

afterAll(() => stop?.());

/** A store with two products at 0 that never sold (two suggestions), and a request as `role` there. */
async function storeWithSuggestions() {
  const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Centro' } });
  const ids: string[] = [];
  for (const name of ['A', 'B']) {
    const { id } = await prisma.product.create({ data: { name } });
    await prisma.productStockStats.create({
      data: { productId: id, locationId, windowDays: 90, unitsSold: 0, weeksWithSales: 0, typicalOnHand: 1, daysAtZero: 10, stockOuts: 1, computedAt: new Date() },
    });
    ids.push(id);
  }
  const { id: employeeId } = await prisma.employee.create({ data: { name: 'Gerente' } });
  const as = (role: string, at = locationId) => {
    const here = { locationId: at, role, isActive: true };
    return { currentLocation: here, accessibleLocations: [here], employee: { id: employeeId } } as any;
  };
  return { locationId, ids, employeeId, as };
}

const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e: any) => e.getStatus());

describe('PauseSuggestionsController', () => {
  test('who may use it', () => {
    const roles = (name: 'list' | 'dismiss') => Reflect.getMetadata(ROLES_KEY, PauseSuggestionsController.prototype[name]);
    assert({
      given: 'the list and dismiss routes',
      should: 'be for owners and managers only (cashiers and accountants get 403)',
      actual: [roles('list'), roles('dismiss')],
      expected: [['OWNER', 'MANAGER'], ['OWNER', 'MANAGER']],
    });
  });

  test('another store', async () => {
    const { locationId, ids } = await storeWithSuggestions();
    const controller = new PauseSuggestionsController(prisma);
    const centro = { locationId: 'centro', role: 'MANAGER', isActive: true };
    const norte = { locationId, role: 'MANAGER', isActive: true };
    const req = { currentLocation: centro, accessibleLocations: [centro, norte] } as any;
    assert({
      given: "a manager at Centro reading or dismissing another store's suggestions",
      should: 'refuse both with 403',
      actual: [
        await statusOf(controller.list(locationId, undefined, undefined, req)),
        await statusOf(controller.dismiss({ locationId, items: [{ productId: ids[0], kind: 'NO_SALES_AT_ZERO' }] }, req)),
      ],
      expected: [403, 403],
    });
  });

  test('a page', async () => {
    const { as } = await storeWithSuggestions();
    const { data, ...page } = await new PauseSuggestionsController(prisma).list(undefined, '1', '1', as('MANAGER'));
    assert({
      given: 'two suggestions at the session store, one to a page',
      should: "answer the first in the product list's paging shape, with the store's window",
      actual: [data.length, page],
      expected: [1, { success: true, count: 1, page: 1, limit: 1, totalCount: 2, totalPages: 2, hasMore: true, windowDays: 90 }],
    });
  });

  test('dismissing', async () => {
    const { locationId, ids, employeeId, as } = await storeWithSuggestions();
    const controller = new PauseSuggestionsController(prisma);
    const answer = await controller.dismiss({ locationId, items: [{ productId: ids[0], kind: 'NO_SALES_AT_ZERO' }] }, as('OWNER'));
    const left = await controller.list(locationId, undefined, undefined, as('OWNER'));
    const saved = await prisma.pauseSuggestionDismissal.findMany({ where: { locationId } });
    assert({
      given: 'an owner dismissing one of two suggestions',
      should: 'save who dismissed it and list only the other',
      actual: [answer, saved.map((d) => d.dismissedByEmployeeId), left.data.map((s) => s.product.id)],
      expected: [{ success: true }, [employeeId], [ids[1]]],
    });
  });
});

describe('ProductsController.getProductCounts pause suggestions', () => {
  test('by role', async () => {
    const { locationId, as } = await storeWithSuggestions();
    const controller = new ProductsController(new ProductsService(prisma), prisma, {} as any, {} as any, {} as any);
    const countFor = async (role: string) => ((await controller.getProductCounts(locationId, as(role))).data as any).pauseSuggestions;
    assert({
      given: 'two suggestions, counted for each role',
      should: 'give the count to owners and managers only',
      actual: [await countFor('OWNER'), await countFor('MANAGER'), await countFor('CASHIER'), await countFor('ACCOUNTANT')],
      expected: [2, 2, undefined, undefined],
    });
  });
});
