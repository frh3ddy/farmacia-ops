import { assert } from 'riteway/vitest';
import { InventoryReceivingController } from './inventory-receiving.controller';
import { ProductsService } from '../products/products.service';

// A manager assigned only to "centro".
const managerRequest = () => ({
  employee: { id: 'e1' },
  currentLocation: { role: 'MANAGER', locationId: 'centro' },
  accessibleLocations: [{ locationId: 'centro', isActive: true }],
}) as any; // fixture: only the fields the controller reads

/** 'done', or the refusal's message. */
const outcome = (promise: Promise<unknown>) => promise.then(() => 'done', (e: any) => e.response?.message ?? e.message);

const receivingAt = (locationId: string) => ({
  id: 'r1',
  locationId,
  unitCost: { toString: () => '2' },
  totalCost: { toString: () => '10' },
  inventoryBatch: null,
});

describe('InventoryReceivingController.getReceiving', () => {
  test('a receiving by id', async () => {
    const outcomeAt = (locationId: string) => {
      const service = { getReceiving: vi.fn().mockResolvedValue(receivingAt(locationId)) };
      return outcome(new InventoryReceivingController(service as any, {} as any).getReceiving('r1', managerRequest()));
    };

    assert({
      given: "a manager of Centro opening one of Norte's receivings, then one of Centro's",
      should: "refuse Norte's (its supplier and cost) and show Centro's",
      actual: [await outcomeAt('norte'), await outcomeAt('centro')],
      expected: ['No tienes acceso a esta sucursal', 'done'],
    });
  });
});

describe('InventoryReceivingController.receiveInventory', () => {
  test('a receiving whose Square sync failed', async () => {
    const raw = 'Status code: 404\nBody: { "errors": [ { "code": "NOT_FOUND", "detail": "This merchant does not have a location with the ID `X`." } ] }';
    const service = { receiveInventory: vi.fn().mockResolvedValue({ receiving: { id: 'r1' }, squareSync: { synced: false, error: raw } }) };
    const products = new ProductsService({} as any);
    vi.spyOn(products, 'getProduct').mockResolvedValue({ data: null } as any);
    const controller = new InventoryReceivingController(service as any, products);

    const { message, data } = await controller.receiveInventory({ productId: 'p1', quantity: 1, unitCost: 8 } as any, managerRequest());

    assert({
      given: 'a receiving saved but refused by Square with its raw 404 body',
      should: 'answer in Spanish with the short reason, never the raw body',
      actual: [message, data.squareSync?.error],
      expected: [
        'Se recibieron 1 unidades — no se sincronizó con Square: Square no reconoce esta tienda. Puedes reintentar desde el historial.',
        'Square no reconoce esta tienda',
      ],
    });
  });

  test('a receiving sent with a price that is not a number', async () => {
    const service = { receiveInventory: vi.fn().mockResolvedValue({ receiving: { id: 'r1' } }) };
    const prisma = { product: { findUnique: vi.fn() } };
    const products = new ProductsService(prisma as any);
    vi.spyOn(products, 'getProduct').mockResolvedValue({ data: null } as any);
    const controller = new InventoryReceivingController(service as any, products);

    const { data } = await controller.receiveInventory(
      { productId: 'p1', quantity: 2, unitCost: 5, sellingPrice: 'abc' } as any,
      managerRequest(),
    );

    assert({
      given: 'a receiving whose selling price is text',
      should: 'record the receiving and report the price as not updated',
      actual: [service.receiveInventory.mock.calls.length, typeof data.priceUpdate?.error, prisma.product.findUnique.mock.calls.length],
      expected: [1, 'string', 0],
    });
  });
});

describe('InventoryReceivingController.retrySquareSync', () => {
  test('a retry Square refuses again', async () => {
    const service = { retrySquareSync: vi.fn().mockResolvedValue({ synced: false, error: 'fetch failed' }) };
    const controller = new InventoryReceivingController(service as any, new ProductsService({} as any));

    const { message, data } = await controller.retrySquareSync('r1');

    assert({
      given: 'a retry that still could not reach Square',
      should: 'answer with the short Spanish reason in both the message and the data the app reads',
      actual: [message, data.error],
      expected: ['No se sincronizó con Square: No se pudo conectar con Square; reintenta más tarde', 'No se pudo conectar con Square; reintenta más tarde'],
    });
  });
});
