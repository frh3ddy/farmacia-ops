/**
 * A store's one-time migration against a real Postgres engine, run in small
 * batches the way the wizard does: every reviewed item gets its opening stock
 * exactly once, whatever happens between batches.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryMigrationService } from './inventory-migration.service';
import { CatalogMapperService } from './catalog-mapper.service';
import { InventoryMigrationController } from './inventory-migration.controller';
import { ROLES_KEY } from '../auth/guards/auth.guard';

let prisma: PrismaService;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
}, 120_000);

afterAll(() => stop?.());

/**
 * A store with `count` reviewed products, each sold as one Square variation
 * mapped at this store only (so other tests' products stay out of its list),
 * with `i` units in Square and an approved cost of $i. `discontinued` are
 * marked no longer for sale (skipped in the session).
 */
async function store(count: number, { discontinued = [] as number[] } = {}) {
  const tag = Math.random().toString(36).slice(2, 8);
  const location = await prisma.location.create({ data: { squareId: `SQ-${tag}`, name: `Tienda ${tag}` } });
  const session = await prisma.extractionSession.create({ data: { locationIds: [location.id], totalItems: count, batchSize: 2 } });
  const counts: { catalogObjectId: string; quantity: number }[] = [];
  const products: { id: string; name: string; variation: string }[] = [];
  const add = async (i: number, isDiscontinued = false) => {
    const variation = `v-${tag}-${String(i).padStart(2, '0')}`;
    const product = await prisma.product.create({ data: { name: `P${i}-${tag}`, squareProductName: `P${i}`, isDiscontinued } });
    await prisma.catalogMapping.create({ data: { productId: product.id, squareVariationId: variation, locationId: location.id } });
    await prisma.costApproval.create({
      data: isDiscontinued
        ? { cutoverId: session.id, productId: product.id, approvedCost: 0, source: 'SKIPPED', migrationStatus: 'SKIPPED' }
        : { cutoverId: session.id, productId: product.id, approvedCost: i, source: 'DESCRIPTION', migrationStatus: 'APPROVED' },
    });
    counts.push({ catalogObjectId: variation, quantity: i });
    products.push({ id: product.id, name: product.name, variation });
    return product;
  };
  for (let i = 1; i <= count; i++) await add(i, discontinued.includes(i));

  const retireVariations = vi.fn(async (ids: string[]) => new Set(ids));
  const service = new InventoryMigrationService(
    prisma,
    { fetchSquareInventory: async () => counts, batchFetchSquareCatalogObjects: async () => new Map() } as any,
    { extractCostFromDescription: () => ({ selectedCost: null }) } as any,
    new CatalogMapperService(prisma),
    {} as any,
    { retireVariations } as any,
  );
  const input = { cutoverDate: new Date('2026-10-29T06:00:00Z'), locationIds: [location.id], costBasis: 'DESCRIPTION' as const, ownerApproved: true };
  const approved = () => service.getCostApprovals(session.id);
  const start = async (batchSize = 2) => service.executeInventoryMigration(input, await approved(), batchSize, null, session.id);
  const next = async (cutoverId: string, options?: { confirmLeftOut?: boolean }) => service.continueBatchMigration(cutoverId, await approved(), options);
  const finish = async (result: Awaited<ReturnType<typeof start>>) => {
    while (result.canContinue) result = await next(result.cutoverId);
    return result;
  };
  /** Opening batches per product name, in product order. */
  const openingStock = async () => {
    const rows = await prisma.inventory.findMany({ where: { locationId: location.id, source: 'OPENING_BALANCE' }, include: { product: true } });
    return Object.fromEntries(products.map((p) => [p.name.split('-')[0], rows.filter((r) => r.productId === p.id).map((r) => r.quantity)]));
  };
  const locks = () => prisma.cutoverLock.count({ where: { locationId: location.id } });
  return { location, session, products, add, service, start, next, finish, openingStock, locks, retireVariations };
}

describe('each item migrated exactly once', () => {
  test('a product deleted and one added between batches', async () => {
    const s = await store(5, { discontinued: [2] });
    const first = await s.start();
    // Between batches: the discontinued product is deleted (and its mapping with it), and a new product is mapped.
    await prisma.costApproval.deleteMany({ where: { productId: s.products[1].id } });
    await prisma.product.delete({ where: { id: s.products[1].id } });
    await s.add(6);
    const result = await s.finish(first);

    assert({
      given: 'five products in batches of two, the second deleted after the first batch and a sixth added',
      should: 'give every product still there its opening stock exactly once and lock the store',
      actual: [await s.openingStock(), result.isComplete, await s.locks()],
      expected: [{ P1: [1], P2: [], P3: [3], P4: [4], P5: [5], P6: [6] }, true, 1],
    });
  });

  test('two calls at once', async () => {
    const s = await store(4);
    const first = await s.start();
    const both = await Promise.allSettled([s.next(first.cutoverId), s.next(first.cutoverId)]);
    const last = both.map((r) => (r.status === 'fulfilled' ? r.value : null)).find((r) => r) ?? first;
    await s.finish({ ...last, canContinue: !last.isComplete });

    assert({
      given: 'the same batch continued twice at once',
      should: 'insert each opening balance once',
      actual: await s.openingStock(),
      expected: { P1: [1], P2: [2], P3: [3], P4: [4] },
    });
  });
});

describe('a failed run resumes', () => {
  test('a batch that fails, then the migration started again', async () => {
    const s = await store(3);
    const transaction = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, '$transaction');
    spy.mockImplementationOnce(transaction as any).mockRejectedValueOnce(new Error('Transaction timed out'));

    const first = await s.start(1);
    await s.next(first.cutoverId).catch(() => undefined);
    spy.mockRestore();
    const failed = await prisma.cutover.findUniqueOrThrow({ where: { id: first.cutoverId } });
    const result = await s.finish(await s.start(1)); // the owner presses Migrar again

    assert({
      given: 'a migration whose second batch failed, started again for the same store and session',
      should: 'continue the same cutover from the items still without stock, never inserting one twice',
      actual: [failed.status, result.cutoverId === first.cutoverId, await s.openingStock(), result.isComplete],
      expected: ['FAILED', true, { P1: [1], P2: [2], P3: [3] }, true],
    });
  });
});

describe('discontinued products', () => {
  test('deleted after the last batch', async () => {
    const s = await store(3, { discontinued: [2] });
    let stockWhenRetired = -1;
    s.retireVariations.mockImplementation(async (ids: string[]) => {
      stockWhenRetired = await prisma.inventory.count({ where: { locationId: s.location.id, source: 'OPENING_BALANCE' } });
      return new Set(ids);
    });
    await s.finish(await s.start(1));

    assert({
      given: 'a product marked no longer for sale, in batches of one',
      should: 'retire only its variation in Square once every batch is done, then delete it',
      actual: [s.retireVariations.mock.calls, stockWhenRetired, await prisma.product.findUnique({ where: { id: s.products[1].id } })],
      expected: [[[[s.products[1].variation]]], 2, null],
    });
  });

  test('a Square failure', async () => {
    const s = await store(2, { discontinued: [2] });
    s.retireVariations.mockResolvedValue(new Set());
    const result = await s.finish(await s.start());

    assert({
      given: 'Square failing to retire a discontinued product',
      should: 'keep the product and say so in the result',
      actual: [!!(await prisma.product.findUnique({ where: { id: s.products[1].id } })), result.warnings.some((w) => w.productName === s.products[1].name)],
      expected: [true, true],
    });
  });
});

describe('no lock with products left out', () => {
  test('a product without a cost', async () => {
    const s = await store(3);
    const withoutP2 = async () => (await s.service.getCostApprovals(s.session.id)).filter((a) => a.productId !== s.products[1].id);
    let result = await s.service.executeInventoryMigration(
      { cutoverDate: new Date('2026-10-29T06:00:00Z'), locationIds: [s.location.id], costBasis: 'DESCRIPTION', ownerApproved: true },
      await withoutP2(),
      2,
      null,
      s.session.id,
    );
    while (result.canContinue) result = await s.service.continueBatchMigration(result.cutoverId, await withoutP2());
    const waiting = { needsConfirmation: result.needsConfirmation, leftOut: result.leftOut?.map((l) => l.productName), locks: await s.locks() };
    const confirmed = await s.service.continueBatchMigration(result.cutoverId, await withoutP2(), { confirmLeftOut: true });

    assert({
      given: 'a product that gets no cost',
      should: 'list it by name and not lock the store until the owner confirms',
      actual: [waiting, confirmed.isComplete, await s.locks()],
      expected: [{ needsConfirmation: true, leftOut: [s.products[1].name], locks: 0 }, true, 1],
    });
  });
});

describe('who may migrate', () => {
  test('owner only', () => {
    const roles = (method: 'cutover' | 'initiateCutover' | 'continueCutover') => Reflect.getMetadata(ROLES_KEY, InventoryMigrationController.prototype[method]);
    assert({
      given: 'the routes that start or continue a cutover',
      should: 'be for the owner only, since a cutover locks a store for good',
      actual: [roles('cutover'), roles('initiateCutover'), roles('continueCutover')],
      expected: [['OWNER'], ['OWNER'], ['OWNER']],
    });
  });
});

