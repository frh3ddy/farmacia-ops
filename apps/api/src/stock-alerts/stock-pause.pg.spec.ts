/**
 * Pausing a product per store and resuming it (see testing/pglite.ts).
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { pauseProduct } from './stock-pause';

let prisma: PrismaService;
let stop: () => Promise<void>;
let centro: string;
let oriente: string;
let manager: string;
let owner: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-C', name: 'Centro' } }));
  ({ id: oriente } = await prisma.location.create({ data: { squareId: 'SQ-O', name: 'Oriente' } }));
  ({ id: manager } = await prisma.employee.create({ data: { name: 'Gerente' } }));
  ({ id: owner } = await prisma.employee.create({ data: { name: 'Dueño' } }));
}, 120_000);

afterAll(() => stop?.());

const product = async (soldOnlyAtLocationId?: string, data: { tracksInventory?: boolean; isDiscontinued?: boolean } = {}) =>
  (await prisma.product.create({ data: { name: `P-${Math.random()}`, soldOnlyAtLocationId, ...data } })).id;

const statusOf = (productId: string) => prisma.productStoreStatus.findMany({ where: { productId }, orderBy: { locationId: 'asc' } });

const refusal = (p: Promise<unknown>) => p.then(() => 'ok', (e: { getStatus?: () => number }) => e.getStatus?.() ?? String(e));

describe('pauseProduct()', () => {
  test('a pause at one store', async () => {
    const id = await product();
    const before = new Date();
    await pauseProduct(prisma, { productId: id, locationId: centro, reason: 'SUPPLIER_UNAVAILABLE', note: 'Sin surtido del proveedor', employeeId: manager });
    const [row, ...others] = await statusOf(id);

    assert({
      given: 'a manager pausing a product at their store with a reason and a note',
      should: 'pause it at that store only, recording the reason, the note, who and when',
      actual: [others.length, row.locationId, row.pauseReason, row.pauseNote, row.pausedByEmployeeId, row.pausedAt! >= before],
      expected: [0, centro, 'SUPPLIER_UNAVAILABLE', 'Sin surtido del proveedor', manager, true],
    });
  });

  test('paused again after a resume', async () => {
    const id = await product();
    await prisma.productStoreStatus.create({
      data: { productId: id, locationId: centro, pausedAt: null, pauseReason: 'OTHER', pauseNote: 'vieja', pausedByEmployeeId: manager, resumedAt: new Date('2026-11-01'), resumeCause: 'STOCK_RECEIVED' },
    });
    await pauseProduct(prisma, { productId: id, locationId: centro, reason: 'SLOW_MOVER', employeeId: owner });
    const [row] = await statusOf(id);

    assert({
      given: 'a product resumed before, paused again without a note',
      should: 'overwrite the pause (reason, no note, who) and clear the last resume',
      actual: [row.pausedAt !== null, row.pauseReason, row.pauseNote, row.pausedByEmployeeId, row.resumedAt, row.resumeCause],
      expected: [true, 'SLOW_MOVER', null, owner, null, null],
    });
  });

  test('refusals', async () => {
    const otherStores = await product(oriente);
    const id = await product();
    const results = [
      await refusal(pauseProduct(prisma, { productId: otherStores, locationId: centro, reason: 'OTHER', employeeId: manager })),
      await refusal(pauseProduct(prisma, { productId: 'no-such-product', locationId: centro, reason: 'OTHER', employeeId: manager })),
      await refusal(pauseProduct(prisma, { productId: id, locationId: centro, reason: 'BECAUSE' as never, employeeId: manager })),
    ];

    assert({
      given: 'a product only another store sells, an unknown product, and an unknown reason',
      should: 'refuse each (400, or 404 for the unknown product) and pause nothing',
      actual: [results, await prisma.productStoreStatus.count({ where: { productId: { in: [otherStores, id] } } })],
      expected: [[400, 404, 400], 0],
    });
  });

  test('products that never alert', async () => {
    const yastas = await product(undefined, { tracksInventory: false });
    const discontinued = await product(undefined, { isDiscontinued: true });

    assert({
      given: 'a Yastás service (no stock) and a discontinued product',
      should: 'refuse both with 400: neither alerts, so there is nothing to pause',
      actual: [
        await refusal(pauseProduct(prisma, { productId: yastas, locationId: centro, reason: 'OTHER', employeeId: manager })),
        await refusal(pauseProduct(prisma, { productId: discontinued, locationId: centro, reason: 'OTHER', employeeId: manager })),
        await prisma.productStoreStatus.count({ where: { productId: { in: [yastas, discontinued] } } }),
      ],
      expected: [400, 400, 0],
    });
  });

  test('stores', async () => {
    const id = await product();
    const { id: closed } = await prisma.location.create({ data: { squareId: 'SQ-X', name: 'Cerrada', isActive: false } });

    assert({
      given: 'a store that doesn\'t exist and an inactive one',
      should: 'refuse with 404 and 400, and pause nothing',
      actual: [
        await refusal(pauseProduct(prisma, { productId: id, locationId: 'no-such-store', reason: 'OTHER', employeeId: owner })),
        await refusal(pauseProduct(prisma, { productId: id, locationId: closed, reason: 'OTHER', employeeId: owner })),
        await prisma.productStoreStatus.count({ where: { productId: id } }),
      ],
      expected: [404, 400, 0],
    });
  });

  test('notes', async () => {
    const id = await product();
    const pause = (note: unknown) => pauseProduct(prisma, { productId: id, locationId: centro, reason: 'OTHER', note: note as string, employeeId: manager });
    const refused = [await refusal(pause(42)), await refusal(pause('x'.repeat(501)))];
    await pause('   ');
    const [blank] = await statusOf(id);
    await pause('  Sin surtido  ');
    const [trimmed] = await statusOf(id);

    assert({
      given: 'a note that isn\'t text, one over 500 characters, a blank one, and one with spaces around it',
      should: 'refuse the first two with 400, store the blank one as none, and trim the last',
      actual: [refused, blank.pauseNote, trimmed.pauseNote],
      expected: [[400, 400], null, 'Sin surtido'],
    });
  });

});

describe('pauseProduct() replaced by an equivalent', () => {
  const groupOf = async (id: string) => (await prisma.product.findUniqueOrThrow({ where: { id } })).equivalenceGroupId;
  const replace = (productId: string, replacedByProductId: string) =>
    pauseProduct(prisma, { productId, locationId: centro, reason: 'REPLACED_BY_EQUIVALENT', replacedByProductId, employeeId: manager });

  test('neither in a group', async () => {
    const [a, b] = [await product(), await product()];
    await replace(a, b);
    const [row] = await statusOf(a);

    assert({
      given: 'a product paused as replaced by another, neither in an equivalence group',
      should: 'keep the replacement on the pause and put both in one new group',
      actual: [row.replacedByProductId, await groupOf(a) !== null, (await groupOf(a)) === (await groupOf(b))],
      expected: [b, true, true],
    });
  });

  test('one already in a group', async () => {
    const [a, b, c] = [await product(), await product(), await product()];
    const { id: group } = await prisma.equivalenceGroup.create({ data: { products: { connect: [{ id: b }, { id: c }] } } });
    await replace(a, b);

    assert({
      given: 'a replacement already in a group with a third product',
      should: 'add the paused product to that group',
      actual: [await groupOf(a), await groupOf(b), await groupOf(c), await prisma.equivalenceGroup.count({ where: { products: { some: { id: a } } } })],
      expected: [group, group, group, 1],
    });
  });

  test('both in different groups', async () => {
    const [a, b, c, d] = [await product(), await product(), await product(), await product()];
    const { id: first } = await prisma.equivalenceGroup.create({ data: { products: { connect: [{ id: a }, { id: c }] } } });
    const { id: second } = await prisma.equivalenceGroup.create({ data: { products: { connect: [{ id: b }, { id: d }] } } });
    await replace(a, b);
    const [row] = await statusOf(a);

    assert({
      given: 'a product and its replacement each in a different group',
      should: 'keep the replacement on the pause and leave both groups as they were',
      actual: [row.replacedByProductId, await groupOf(a), await groupOf(c), await groupOf(b), await groupOf(d)],
      expected: [b, first, first, second, second],
    });
  });

  test('paused again without a replacement', async () => {
    const [a, b] = [await product(), await product()];
    await replace(a, b);
    await pauseProduct(prisma, { productId: a, locationId: centro, reason: 'SUPPLIER_UNAVAILABLE', employeeId: manager });
    const [row] = await statusOf(a);

    assert({
      given: 'a product replaced by another, then paused again for another reason',
      should: 'drop the replacement from the pause',
      actual: row.replacedByProductId,
      expected: null,
    });
  });

  test('refused replacements', async () => {
    const [a, b] = [await product(), await product()];
    const results = [
      await refusal(pauseProduct(prisma, { productId: a, locationId: centro, reason: 'SLOW_MOVER', replacedByProductId: b, employeeId: manager })),
      await refusal(replace(a, 'no-such-product')),
      await refusal(replace(a, a)),
      await refusal(replace(a, 42 as never)),
    ];

    assert({
      given: 'a replacement with another reason, an unknown replacement, the product itself, and an id that isn\'t text',
      should: 'refuse each with 400, pausing and grouping nothing',
      actual: [results, await prisma.productStoreStatus.count({ where: { productId: a } }), await groupOf(a)],
      expected: [[400, 400, 400, 400], 0, null],
    });
  });

  test('replacements that can\'t stand in', async () => {
    const a = await product();
    const yastas = await product(undefined, { tracksInventory: false });
    const discontinued = await product(undefined, { isDiscontinued: true });
    const elsewhere = await product(oriente);
    const results = [await refusal(replace(a, yastas)), await refusal(replace(a, discontinued)), await refusal(replace(a, elsewhere))];

    assert({
      given: 'a Yastás service, a discontinued product, and one only another store sells as the replacement',
      should: 'refuse each with 400, pausing and grouping nothing',
      actual: [results, await prisma.productStoreStatus.count({ where: { productId: a } }), await groupOf(a)],
      expected: [[400, 400, 400], 0, null],
    });
  });

  test('both already in the same group', async () => {
    const [a, b] = [await product(), await product()];
    const { id: group } = await prisma.equivalenceGroup.create({ data: { products: { connect: [{ id: a }, { id: b }] } } });
    const before = await prisma.equivalenceGroup.count();
    await replace(a, b);

    assert({
      given: 'a product and its replacement already in one group',
      should: 'keep them there and create no other group',
      actual: [await groupOf(a), await groupOf(b), (await prisma.equivalenceGroup.count()) - before],
      expected: [group, group, 0],
    });
  });
});
