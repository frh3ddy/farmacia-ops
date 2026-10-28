import { assert } from 'riteway/vitest';
import { TransferController } from './transfer.controller';
import { TransferService } from './transfer.service';

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
