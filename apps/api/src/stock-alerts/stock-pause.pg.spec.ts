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
