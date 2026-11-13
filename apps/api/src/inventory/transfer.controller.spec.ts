import { assert } from 'riteway/vitest';
import { TransferController } from './transfer.controller';
import { TransferService } from './transfer.service';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '../auth/guards/auth.guard';

// A manager assigned only to "centro".
const managerRequest = () => ({
  employee: { id: 'e1' },
  currentLocation: { role: 'MANAGER', locationId: 'centro' },
  accessibleLocations: [{ locationId: 'centro', isActive: true }],
}) as any; // fixture: only the fields the controller reads

/** 'done', or the refusal's message. */
const outcome = (promise: Promise<unknown>) => promise.then(() => 'done', (e: Error) => e.message);

// Real TransferService over a Prisma stub holding one in-transit transfer.
function controllerWithTransfer(transfer: object) {
  const prisma = {
    transfer: { findUnique: vi.fn().mockResolvedValue({ status: 'IN_TRANSIT', lines: [], ...transfer }) },
    $transaction: vi.fn(),
  };
  return { controller: new TransferController(new TransferService(prisma as any, {} as any)), prisma };
}

describe('TransferController.ship', () => {
  test('shipping from another location', async () => {
    // Regression: LocationGuard only reads `locationId`, so body.fromLocationId
    // let a manager move another store's stock.
    const transferService = { ship: vi.fn() };
    const controller = new TransferController(transferService as any);
    const body = { productId: 'p1', fromLocationId: 'norte', toLocationId: 'centro', quantity: 2 };

    assert({
      given: 'a manager shipping from a store they are not assigned to',
      should: 'refuse the shipment',
      actual: await outcome(controller.ship(body as any, managerRequest())),
      expected: 'No tienes acceso a esta sucursal',
    });
    assert({
      given: 'a refused shipment',
      should: 'move no stock',
      actual: transferService.ship.mock.calls.length,
      expected: 0,
    });
  });
});

describe('TransferController.ship (allowed)', () => {
  test('shipping from own location', async () => {
    const transferService = { ship: vi.fn().mockResolvedValue({}) };
    const controller = new TransferController(transferService as any);
    const body = { productId: 'p1', fromLocationId: 'centro', toLocationId: 'norte', quantity: 2 };

    assert({
      given: 'a manager shipping from the store they are assigned to',
      should: 'ship the stock',
      actual: await outcome(controller.ship(body as any, managerRequest())),
      expected: 'done',
    });
  });
});

describe('TransferController.receive', () => {
  test('receiving a transfer headed to another location', async () => {
    // Regression: receive checked no location, so any manager could book
    // another store's incoming stock as received.
    const { controller, prisma } = controllerWithTransfer({ id: 't1', fromLocationId: 'centro', toLocationId: 'norte' });

    assert({
      given: 'a manager receiving a transfer headed to a different store',
      should: 'refuse the receipt',
      actual: await outcome(controller.receive('t1', {} as any, managerRequest())),
      expected: 'No tienes acceso a esta sucursal',
    });
    assert({
      given: 'a refused receipt',
      should: 'record no stock',
      actual: prisma.$transaction.mock.calls.length,
      expected: 0,
    });
  });
});

describe('TransferController.receive (allowed)', () => {
  test('receiving a transfer headed to own location', async () => {
    const { controller, prisma } = controllerWithTransfer({ id: 't1', fromLocationId: 'norte', toLocationId: 'centro' });
    await outcome(controller.receive('t1', {} as any, managerRequest()));

    assert({
      given: 'a manager receiving a transfer headed to the store they are assigned to',
      should: 'get past the access check and record the receipt',
      actual: prisma.$transaction.mock.calls.length,
      expected: 1,
    });
  });
});

describe('TransferController.getTransfers', () => {
  test('a status that does not exist', async () => {
    const transferService = { getTransfers: vi.fn() };
    const controller = new TransferController(transferService as any);

    const status = await controller.getTransfers('centro', 'SHIPPED', managerRequest()).then(() => 200, (e: any) => e.status);

    assert({
      given: 'a transfers list filtered by an unknown status',
      should: 'answer 400 without querying',
      actual: [status, transferService.getTransfers.mock.calls.length],
      expected: [400, 0],
    });
  });
});

describe('TransferController.retrySquareSync', () => {
  test('a retry Square refuses again', async () => {
    const transferService = { retrySquareSync: vi.fn().mockResolvedValue({ synced: false, error: 'Product not mapped to Square catalog' }) };
    const controller = new TransferController(transferService as any);

    const { message, data } = await controller.retrySquareSync('t1');

    assert({
      given: 'a transfer retry for a product missing from the Square catalog',
      should: 'answer with the short Spanish reason in the message and data',
      actual: [message, data.error],
      expected: ['No se sincronizó con Square: El producto no está en el catálogo de Square', 'El producto no está en el catálogo de Square'],
    });
  });
});

describe('TransferController.getStock', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
  /** The status and stable code of a refusal, or 200. */
  const refusal = (p: Promise<unknown>) => p.then(() => [200], (e: any) => [e.getStatus(), e.getResponse().code]);

  test('a valid request', async () => {
    const transferService = { stockAt: vi.fn().mockResolvedValue({ p0: 4 }) };
    const controller = new TransferController(transferService as any);

    assert({
      given: 'a manager asking for stock at their own store',
      should: 'answer the stock by product id',
      actual: [await controller.getStock({ locationId: 'centro', productIds: ['p0', 'p1'] }, managerRequest()), transferService.stockAt.mock.calls],
      expected: [{ success: true, data: { p0: 4 } }, [['centro', ['p0', 'p1']]]],
    });
  });

  test('bad bodies', async () => {
    const transferService = { stockAt: vi.fn() };
    const controller = new TransferController(transferService as any);
    const ask = (body: object) => refusal(controller.getStock(body as any, managerRequest()));

    assert({
      given: '101 ids, none, duplicates, a non-string id, ids not in a list and no location',
      should: 'answer 400 with a stable code and query nothing',
      actual: [
        await ask({ locationId: 'centro', productIds: ids(101) }),
        await ask({ locationId: 'centro', productIds: [] }),
        await ask({ locationId: 'centro', productIds: ['p0', 'p0'] }),
        await ask({ locationId: 'centro', productIds: ['p0', 7] }),
        await ask({ locationId: 'centro', productIds: 'p0' }),
        await ask({ productIds: ['p0'] }),
        transferService.stockAt.mock.calls.length,
      ],
      expected: [
        [400, 'TOO_MANY_PRODUCT_IDS'],
        [400, 'INVALID_PRODUCT_IDS'],
        [400, 'INVALID_PRODUCT_IDS'],
        [400, 'INVALID_PRODUCT_IDS'],
        [400, 'INVALID_PRODUCT_IDS'],
        [400, 'LOCATION_REQUIRED'],
        0,
      ],
    });
  });

  test('another store', async () => {
    const transferService = { stockAt: vi.fn() };
    const controller = new TransferController(transferService as any);

    assert({
      given: "a manager asking for a store they aren't assigned to",
      should: 'refuse with 403',
      actual: await refusal(controller.getStock({ locationId: 'norte', productIds: ['p0'] }, managerRequest())),
      expected: [403, undefined],
    });
  });

  test('a cashier', async () => {
    const cashier = { role: 'CASHIER', locationId: 'centro', isActive: true };
    const authService = { validateSession: vi.fn().mockResolvedValue({ session: {}, employee: {}, currentLocation: cashier, accessibleLocations: [cashier] }) };
    const request = { headers: { 'x-session-token': 's1' } };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => TransferController.prototype.getStock,
      getClass: () => TransferController,
    } as any;

    assert({
      given: 'a cashier at the store asking for its stock',
      should: 'be refused by the role check with 403',
      actual: await new AuthGuard(authService as any, new Reflector()).canActivate(context).then(() => 200, (e: any) => e.getStatus()),
      expected: 403,
    });
  });
});
