import { HttpException } from '@nestjs/common';
import { assert } from 'riteway/vitest';
import { CatalogService, productByVariation } from './catalog.service';
import { CatalogController } from './catalog.controller';
import { ROLES_KEY } from '../auth/guards/auth.guard';

type Mapping = { id?: string; squareVariationId: string; locationId: string | null; employeeId?: string | null; product: object };
type Variation = { id: string; type: 'ITEM_VARIATION'; itemVariationData: { name?: string; itemId?: string; sku?: string } };

const aspirina = { id: 'p-aspirina', name: 'Aspirina', sku: null, squareDataSyncedAt: new Date() };
const variation = (id: string, data: Variation['itemVariationData'] = { name: 'Regular', itemId: 'i1' }): Variation => ({ id, type: 'ITEM_VARIATION', itemVariationData: data });
const item = (id: string, name: string, extra: object = {}) => ({ id, type: 'ITEM', itemData: { name, ...extra } });

/** A sync against fakes; `mappings` are the existing CatalogMapping rows (any scope). */
function setup({
  variations = [variation('v1')] as Variation[],
  items = [item('i1', 'Aspirina')] as object[],
  mappings = [] as Mapping[],
  lock = null as object | null,
  location = { id: 'loc-norte', name: 'Norte' } as object | null,
  createProduct = vi.fn(async ({ data }: { data: { name: string; sku: string | null } }) => ({ id: `p-${data.name}`, ...data })),
  productBySku = null as object | null,
} = {}) {
  const tx = {
    product: { create: createProduct, update: vi.fn(async ({ where }: any) => ({ id: where.id })), findUnique: vi.fn() },
    catalogMapping: { create: vi.fn(), update: vi.fn() },
  };
  const prisma = {
    location: { findUnique: vi.fn(async () => location) },
    cutoverLock: { findFirst: vi.fn(async () => lock) },
    catalogMapping: {
      findMany: vi.fn(async ({ where }: any) => mappings.filter((m) => !('locationId' in where) || m.locationId === where.locationId)),
    },
    product: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => productBySku) },
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const search = vi.fn(async () => ({ objects: variations, relatedObjects: items }));
  const service = new CatalogService(prisma as any);
  vi.spyOn(service as any, 'getSquareClient').mockReturnValue({
    catalog: { search, batchGet: vi.fn(async ({ objectIds }: any) => ({ objects: variations.filter((v) => objectIds.includes(v.id)), relatedObjects: items })) },
  });
  const sync = async (locationId: string | null = 'loc-norte', forceResync = false) => {
    try {
      return await service.syncSquareCatalog(locationId, forceResync);
    } catch (error) {
      return error instanceof HttpException ? [error.getStatus(), (error.getResponse() as { message: string }).message] : error;
    }
  };
  return { sync, tx, prisma, search };
}

describe('syncSquareCatalog by location', () => {
  test('a SKU-less variation mapped globally', async () => {
    const { sync, tx } = setup({ mappings: [{ squareVariationId: 'v1', locationId: null, product: aspirina }] });
    const result: any = await sync();
    assert({
      given: 'a store sync of a SKU-less variation that already has a global mapping',
      should: 'reuse its product for the store mapping, not create a duplicate',
      actual: [result.errors, tx.product.create.mock.calls.length, tx.catalogMapping.create.mock.calls[0]?.[0].data.productId],
      expected: [[], 0, 'p-aspirina'],
    });
  });
});

describe('only during the migration', () => {
  test('after cutover', async () => {
    const refused = [400, 'La sincronización del catálogo es solo para la migración: esta sucursal ya hizo su corte.'];
    const store = setup({ lock: { locationId: 'loc-norte', isLocked: true } });
    const every = setup({ lock: { locationId: 'loc-sur', isLocked: true } });
    assert({
      given: 'a sync for a store that has cut over, and a sync of every store once any store has',
      should: 'refuse both without reading Square',
      actual: [await store.sync(), await every.sync(null), store.search.mock.calls.length + every.search.mock.calls.length],
      expected: [refused, [400, 'La sincronización del catálogo es solo para la migración: ya hay sucursales con corte.'], 0],
    });
    assert({
      given: 'the lock looked up for a store',
      should: 'be that store’s or one for every store',
      actual: (store.prisma.cutoverLock.findFirst.mock.calls[0] as any)[0].where,
      expected: { isLocked: true, OR: [{ locationId: 'loc-norte' }, { locationId: null }] },
    });
  });

  test('an unknown store', async () => {
    assert({
      given: 'a locationId that isn’t a store',
      should: 'answer 400 in Spanish',
      actual: await setup({ location: null }).sync(),
      expected: [400, 'Sucursal no encontrada'],
    });
  });
});

describe('Yastás items', () => {
  test('a store sync next to an employee’s mapping', async () => {
    const { sync, tx } = setup({ mappings: [{ squareVariationId: 'v1', locationId: null, employeeId: 'emp-ana', product: aspirina }] });
    const result: any = await sync();
    assert({
      given: 'a variation whose global mapping carries an employee (a Yastás item)',
      should: 'leave it to that mapping instead of adding a store mapping without the employee',
      actual: [tx.catalogMapping.create.mock.calls.length, result.mappingsSkipped],
      expected: [0, 1],
    });
  });
});

describe('archived Square items', () => {
  test('an archived item', async () => {
    const { sync, tx } = setup({ items: [item('i1', 'Aspirina', { isArchived: true })] });
    const result: any = await sync();
    assert({
      given: 'a variation of an item archived in Square',
      should: 'create no product or mapping and count it as skipped',
      actual: [tx.product.create.mock.calls.length, tx.catalogMapping.create.mock.calls.length, result.mappingsSkipped],
      expected: [0, 0, 1],
    });
  });
});

describe('names', () => {
  test('variation names', async () => {
    const { sync, tx } = setup({
      variations: [variation('v1', { name: 'Regular 500 ml', itemId: 'i1' }), variation('v2', { name: 'Regular', itemId: 'i1' }), variation('v3', { name: 'Regular', itemId: 'gone' })],
      items: [item('i1', 'Alcohol')],
    });
    await sync();
    assert({
      given: 'a variation named "Regular 500 ml", one named "Regular", and one whose item Square didn’t return',
      should: 'keep the real variation name, use the item name alone, and fall back to a placeholder the repair recognizes',
      actual: tx.product.create.mock.calls.map(([{ data }]) => data.name).sort(),
      expected: ['Alcohol', 'Alcohol (Regular 500 ml)', 'Regular'],
    });
  });
});

describe('two variations with one SKU', () => {
  test('a SKU clash while creating', async () => {
    const clash = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    const existing = { id: 'p-gasas', name: 'Gasas', sku: 'G-1' };
    const { sync, tx, prisma } = setup({
      variations: [variation('v1', { name: 'Regular', itemId: 'i1', sku: 'G-1' })],
      createProduct: vi.fn().mockRejectedValueOnce(clash),
      productBySku: existing,
    });
    const result: any = await sync();
    assert({
      given: 'a product created with the same SKU while this one was being created',
      should: 'look it up outside the failed transaction and map to it',
      actual: [result.errors, tx.product.findUnique.mock.calls.length, prisma.product.findUnique.mock.calls.length, tx.catalogMapping.create.mock.calls[0]?.[0].data.productId],
      expected: [[], 0, 1, 'p-gasas'],
    });
  });
});

describe('the sync route', () => {
  const controller = (syncSquareCatalog: () => Promise<unknown>) => new CatalogController({ syncSquareCatalog } as any);
  const run = async (fail: Error) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await controller(async () => Promise.reject(fail)).syncCatalog({});
    } catch (error) {
      return error instanceof HttpException ? [error.getStatus(), (error.getResponse() as { message: string }).message] : error;
    }
  };

  test('who may sync, and failures', async () => {
    assert({
      given: 'the catalog sync route',
      should: 'be for the owner only',
      actual: Reflect.getMetadata(ROLES_KEY, CatalogController),
      expected: ['OWNER'],
    });
    assert({
      given: 'a refusal, and an unexpected database error',
      should: 'pass the refusal on, and answer the error in Spanish without its raw message',
      actual: [await run(new HttpException({ message: 'Sucursal no encontrada' }, 400)), await run(new Error('Invalid `prisma.product.create()` invocation'))],
      expected: [[400, 'Sucursal no encontrada'], [500, 'No se pudo sincronizar el catálogo. Intenta de nuevo.']],
    });
  });
});

describe('productByVariation', () => {
  test('global before store mappings', () => {
    assert({
      given: 'a variation mapped globally and at a store, and one mapped only at a store',
      should: 'prefer the global mapping',
      actual: Object.fromEntries(
        productByVariation([
          { squareVariationId: 'v1', locationId: 'loc-sur', product: 'scoped' },
          { squareVariationId: 'v1', locationId: null, product: 'global' },
          { squareVariationId: 'v2', locationId: 'loc-sur', product: 'only-scoped' },
        ]),
      ),
      expected: { v1: 'global', v2: 'only-scoped' },
    });
  });
});
