/**
 * Shipments (several products sent together, one transfer each) against a real
 * Postgres engine (see testing/pglite.ts), with Square's inventory call recorded.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { TransferService } from './transfer.service';
import { TransferController } from './transfer.controller';

let prisma: PrismaService;
let stop: () => Promise<void>;
let centro: string;
let norte: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } }));
  ({ id: norte } = await prisma.location.create({ data: { squareId: 'SQ-NORTE', name: 'Norte' } }));
  await prisma.cutoverLock.createMany({ data: [centro, norte].map((locationId) => ({ locationId, cutoverDate: new Date('2026-09-01') })) });
}, 120_000);

afterAll(() => stop?.());

/** Services sharing one recorded Square client. */
function services() {
  const batchCreateChanges = vi.fn().mockResolvedValue({ counts: [] });
  const square = { inventory: { batchCreateChanges } } as any;
  const adjustments = new InventoryAdjustmentService(prisma);
  adjustments['squareClient'] = square;
  const transfers = new TransferService(prisma, adjustments);
  transfers['squareClient'] = square;
  return { transfers, batchCreateChanges };
}

/** A mapped product with `units` at Centro. */
async function productWith(units = 10) {
  const product = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
  await prisma.catalogMapping.create({ data: { productId: product.id, squareVariationId: `v-${product.id}` } });
  await prisma.inventory.create({ data: { productId: product.id, locationId: centro, quantity: units, unitCost: 2, receivedAt: new Date('2026-10-01') } });
  return product.id;
}

const stockAt = async (locationId: string, productId: string) =>
  (await prisma.inventory.aggregate({ where: { locationId, productId }, _sum: { quantity: true } }))._sum.quantity ?? 0;

const send = (transfers: TransferService, items: { productId: string; quantity: number }[], extra: object = {}) =>
  transfers.shipBatch({
    fromLocationId: centro,
    toLocationId: norte,
    clientRequestId: `req-${Math.random()}`,
    receiveOnSend: false,
    items,
    ...extra,
  });

/** The refusal's status and body, or 'done'. */
const refusal = (p: Promise<unknown>) => p.then(() => 'done', (e: any) => ({ status: e.status, ...e.getResponse?.() }));

describe('TransferService.shipBatch (Postgres, Square recorded)', () => {
  test('several products confirmed on arrival', async () => {
    const { transfers, batchCreateChanges } = services();
    const [a, b] = [await productWith(), await productWith()];

    const shipment = await send(transfers, [{ productId: a, quantity: 3 }, { productId: b, quantity: 4 }]);

    assert({
      given: 'two products sent to be confirmed on arrival',
      should: 'take them from the origin as one shipment in transit, one transfer each, and tell Square nothing yet',
      actual: [
        shipment.status,
        shipment.transfers.map((t: any) => [t.product.id, t.quantity, t.status]).sort(),
        [await stockAt(centro, a), await stockAt(centro, b), await stockAt(norte, a)],
        batchCreateChanges.mock.calls.length,
      ],
      expected: [
        'IN_TRANSIT',
        [[a, 3, 'IN_TRANSIT'], [b, 4, 'IN_TRANSIT']].sort(),
        [7, 6, 0],
        0,
      ],
    });
  });

  test('received on send', async () => {
    const { transfers, batchCreateChanges } = services();
    const [a, b] = [await productWith(), await productWith()];

    const shipment = await send(transfers, [{ productId: a, quantity: 3 }, { productId: b, quantity: 4 }], { receiveOnSend: true, createdBy: 'e1' });

    assert({
      given: 'two products sent with receive on send',
      should: 'move them to the destination in the same step and tell Square once per product',
      actual: [
        shipment.status,
        shipment.transfers.map((t: any) => t.status),
        shipment.transfers.map((t: any) => t.squareSynced),
        [await stockAt(norte, a), await stockAt(norte, b)],
        batchCreateChanges.mock.calls.length,
      ],
      expected: ['RECEIVED', ['RECEIVED', 'RECEIVED'], [true, true], [3, 4], 2],
    });
  });

  test('a resend', async () => {
    const { transfers } = services();
    const a = await productWith();
    const input = { productId: a, quantity: 3 };

    const first = await send(transfers, [input], { clientRequestId: 'same-send' });
    const again = await send(transfers, [input], { clientRequestId: 'same-send' });

    assert({
      given: 'the same send sent twice',
      should: 'ship it once and answer the resend with the first shipment',
      actual: [again.id, await stockAt(centro, a), await prisma.shipment.count({ where: { clientRequestId: 'same-send' } })],
      expected: [first.id, 7, 1],
    });
  });

  test('two copies of a send racing', async () => {
    const { transfers } = services();
    const a = await productWith();
    const first = await send(transfers, [{ productId: a, quantity: 3 }], { clientRequestId: 'raced-id' });
    // The second copy's lookup ran before the first committed, so it found nothing.
    vi.spyOn(transfers as any, 'replayOf').mockResolvedValueOnce(null);

    const again = await send(transfers, [{ productId: a, quantity: 3 }], { clientRequestId: 'raced-id' });

    assert({
      given: 'a copy of a send that missed the first one and hit its request id on insert',
      should: 'answer with the first shipment and roll back its own stock taking',
      actual: [again.id, await stockAt(centro, a)],
      expected: [first.id, 7],
    });
  });

  test("another store's request id", async () => {
    const { transfers } = services();
    const a = await productWith();
    await prisma.inventory.create({ data: { productId: a, locationId: norte, quantity: 5, unitCost: 2, receivedAt: new Date('2026-10-01') } });
    await send(transfers, [{ productId: a, quantity: 3 }], { clientRequestId: 'shared-id' });

    const reused: any = await refusal(send(transfers, [{ productId: a, quantity: 1 }], { clientRequestId: 'shared-id', fromLocationId: norte, toLocationId: centro }));

    assert({
      given: 'a request id already used by a send from another store',
      should: "refuse with a conflict instead of answering with that store's shipment, and move nothing",
      actual: [reused.status, reused.code, reused.id, await stockAt(norte, a)],
      expected: [409, 'CLIENT_REQUEST_ID_REUSED', undefined, 5],
    });
  });

  test('one product short', async () => {
    const { transfers } = services();
    const [a, b] = [await productWith(10), await productWith(2)];

    const error = await refusal(send(transfers, [{ productId: a, quantity: 3 }, { productId: b, quantity: 5 }]));

    assert({
      given: 'a send where one product has less stock than asked',
      should: 'refuse it naming that product and move nothing',
      actual: [error, await stockAt(centro, a), await prisma.transfer.count({ where: { productId: { in: [a, b] } } })],
      expected: [
        { status: 400, success: false, code: 'INSUFFICIENT_STOCK', productId: b, requested: 5, available: 2, message: 'No hay suficientes existencias: se pidieron 5 y hay 2' },
        10,
        0,
      ],
    });
  });

  test('items that cannot be sent', async () => {
    const { transfers } = services();
    const a = await productWith();
    const soldOnlyHere = await productWith();
    await prisma.product.update({ where: { id: soldOnlyHere }, data: { soldOnlyAtLocationId: centro } });
    const { id: oriente } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Oriente' } });
    const codeOf = async (p: Promise<unknown>) => {
      const r: any = await refusal(p);
      return [r.status, r.code, r.productId];
    };

    assert({
      given: 'a product listed twice, more than 100 items, a fractional quantity, the same store on both sides, a store not cut over, or a product the destination does not sell',
      should: 'refuse each with its own code, naming the product when one is at fault',
      actual: [
        await codeOf(send(transfers, [{ productId: a, quantity: 1 }, { productId: a, quantity: 2 }])),
        await codeOf(send(transfers, Array.from({ length: 101 }, (_, i) => ({ productId: `p-${i}`, quantity: 1 })))),
        await codeOf(send(transfers, [{ productId: a, quantity: 1.5 }])),
        await codeOf(send(transfers, [{ productId: a, quantity: 1 }], { toLocationId: centro })),
        await codeOf(send(transfers, [{ productId: a, quantity: 1 }], { toLocationId: oriente })),
        await codeOf(send(transfers, [{ productId: soldOnlyHere, quantity: 1 }])),
        await stockAt(centro, a),
      ],
      expected: [
        [400, 'DUPLICATE_PRODUCT', a],
        [400, 'TOO_MANY_ITEMS', undefined],
        [400, 'INVALID_QUANTITY', a],
        [400, 'SAME_LOCATION', undefined],
        [400, 'DESTINATION_NOT_CUT_OVER', undefined],
        [400, 'PRODUCT_NOT_SOLD_AT_LOCATION', soldOnlyHere],
        10,
      ],
    });
  });
});

describe('TransferService.shipBatch input', () => {
  test('items without a product', async () => {
    const { transfers } = services();
    const a = await productWith();
    const codeOf = async (items: unknown[]) => {
      const r: any = await refusal(send(transfers, items as any));
      return [r.status, r.code];
    };

    assert({
      given: 'an item with no product id, or an empty item',
      should: 'refuse it as a bad item and move nothing',
      actual: [await codeOf([{ quantity: 1 }]), await codeOf([{ productId: a, quantity: 1 }, null]), await stockAt(centro, a)],
      expected: [[400, 'INVALID_ITEM'], [400, 'INVALID_ITEM'], 10],
    });
  });

  test('the order stock is taken in', async () => {
    const { transfers } = services();
    const ids = [await productWith(), await productWith(), await productWith()];
    const taken = vi.spyOn(transfers['adjustments'], 'createAdjustment');
    const sorted = [...ids].sort();

    await send(transfers, [...sorted].reverse().map((productId) => ({ productId, quantity: 1 })));

    assert({
      given: 'products listed in any order',
      should: 'take their stock in product id order, so two overlapping sends lock rows in the same order',
      actual: taken.mock.calls.map(([input]) => input.productId),
      expected: sorted,
    });
  });

  test('Square down while receiving on send', async () => {
    const { transfers, batchCreateChanges } = services();
    batchCreateChanges.mockRejectedValue(new Error('Square is down'));
    const a = await productWith();

    const shipment = await send(transfers, [{ productId: a, quantity: 3 }], { receiveOnSend: true });

    assert({
      given: 'a receive-on-send while Square refuses the stock change',
      should: 'still send and receive the stock, and record the failure on the transfer for a retry',
      actual: [shipment.status, await stockAt(norte, a), shipment.transfers[0].squareSynced, shipment.transfers[0].squareSyncError],
      expected: ['RECEIVED', 3, false, 'Square is down'],
    });
  });
});

describe('TransferService.receiveShipment (Postgres, Square recorded)', () => {
  test('one line arrived short', async () => {
    const { transfers, batchCreateChanges } = services();
    const [a, b] = [await productWith(), await productWith()];
    const shipment = await send(transfers, [{ productId: a, quantity: 3 }, { productId: b, quantity: 4 }]);
    const lineOfB = shipment.transfers.find((t: any) => t.product.id === b)!.lines[0].id;

    const received = await transfers.receiveShipment({ shipmentId: shipment.id, lineReceipts: [{ transferLineId: lineOfB, quantityReceived: 1 }] });

    assert({
      given: 'a shipment received with one line counted short',
      should: 'receive every product at its sent quantity except that line, and tell Square once per product',
      actual: [received.status, [await stockAt(norte, a), await stockAt(norte, b)], batchCreateChanges.mock.calls.length],
      expected: ['RECEIVED', [3, 1], 2],
    });
  });

  test('a product already received alone', async () => {
    const { transfers } = services();
    const [a, b] = [await productWith(), await productWith()];
    const shipment = await send(transfers, [{ productId: a, quantity: 3 }, { productId: b, quantity: 4 }]);
    await transfers.receive({ transferId: shipment.transfers.find((t: any) => t.product.id === a)!.id });

    await transfers.receiveShipment({ shipmentId: shipment.id });
    const again = await refusal(transfers.receiveShipment({ shipmentId: shipment.id }));

    assert({
      given: 'a shipment one of whose products was received on its own',
      should: 'receive only the rest, and refuse a second receive with a conflict',
      actual: [[await stockAt(norte, a), await stockAt(norte, b)], again.status],
      expected: [[3, 4], 409],
    });
  });

  test('a line from another shipment', async () => {
    const { transfers } = services();
    const a = await productWith();
    const shipment = await send(transfers, [{ productId: a, quantity: 3 }]);
    const other = await send(transfers, [{ productId: await productWith(), quantity: 1 }]);

    const error = await refusal(transfers.receiveShipment({
      shipmentId: shipment.id,
      lineReceipts: [{ transferLineId: other.transfers[0].lines[0].id, quantityReceived: 1 }],
    }));

    assert({
      given: 'a receipt for a line that is not in the shipment',
      should: 'refuse it and receive nothing',
      actual: [error.status, await stockAt(norte, a)],
      expected: [400, 0],
    });
  });
});

describe('TransferService.getShipments (Postgres)', () => {
  test('by status and store', async () => {
    const { transfers } = services();
    const { id: sur } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Sur' } });
    await prisma.cutoverLock.create({ data: { locationId: sur, cutoverDate: new Date('2026-09-01') } });
    const inTransit = await send(transfers, [{ productId: await productWith(), quantity: 1 }], { toLocationId: sur });
    const received = await send(transfers, [{ productId: await productWith(), quantity: 1 }], { toLocationId: sur, receiveOnSend: true });
    const partly = await send(transfers, [{ productId: await productWith(), quantity: 1 }, { productId: await productWith(), quantity: 1 }], { toLocationId: sur });
    await transfers.receive({ transferId: partly.transfers[0].id });

    const ids = async (status?: 'IN_TRANSIT' | 'RECEIVED') => (await transfers.getShipments({ locationId: sur, status })).map((s) => s.id);

    assert({
      given: "a store's shipments: in transit, received, and one with a product received on its own",
      should: 'list them newest first, and count a shipment in transit while any of its products is',
      actual: [await ids(), await ids('IN_TRANSIT'), await ids('RECEIVED')],
      expected: [[partly.id, received.id, inTransit.id], [partly.id, inTransit.id], [received.id]],
    });
  });
});

describe('TransferController shipments', () => {
  const manager = (locationIds: string[]) => ({
    employee: { id: 'e1' },
    currentLocation: { role: 'MANAGER', locationId: centro },
    accessibleLocations: locationIds.map((locationId) => ({ locationId, isActive: true })),
  }) as any;

  test('receive on send without the destination', async () => {
    const { transfers } = services();
    const controller = new TransferController(transfers);
    const a = await productWith();
    const body = { toLocationId: norte, clientRequestId: `req-${Math.random()}`, receiveOnSend: true, items: [{ productId: a, quantity: 2 }] };

    const refused: any = await refusal(controller.shipBatch(body, manager([centro])));
    const sent = await controller.shipBatch({ ...body, clientRequestId: `req-${Math.random()}` }, manager([centro, norte]));

    assert({
      given: 'a receive-on-send from a manager of the origin only, then from a manager of both stores',
      should: 'refuse the first with its own code and send the second',
      actual: [refused.status, refused.code, sent.data.status, await stockAt(norte, a)],
      expected: [403, 'RECEIVE_ON_SEND_NOT_ALLOWED', 'RECEIVED', 2],
    });
  });

  test('a send without a clear receive-on-send choice', async () => {
    const { transfers } = services();
    const controller = new TransferController(transfers);
    const a = await productWith();
    const body = (receiveOnSend: unknown) =>
      ({ toLocationId: norte, clientRequestId: `req-${Math.random()}`, receiveOnSend, items: [{ productId: a, quantity: 1 }] }) as any;

    const statuses = [];
    for (const choice of [undefined, 'false', 1]) statuses.push((await refusal(controller.shipBatch(body(choice), manager([centro, norte])))).status);

    assert({
      given: 'receive on send left out or sent as something other than true or false',
      should: 'refuse it with a 400 and move nothing',
      actual: [statuses, await stockAt(centro, a)],
      expected: [[400, 400, 400], 10],
    });
  });

  test('receiving at a store the manager is not assigned to', async () => {
    const { transfers } = services();
    const controller = new TransferController(transfers);
    const a = await productWith();
    const shipment = await send(transfers, [{ productId: a, quantity: 2 }]);

    const refused: any = await refusal(controller.receiveShipment(shipment.id, {}, manager([centro])));

    assert({
      given: "a manager of the origin receiving a shipment at a store they can't access",
      should: 'refuse it and receive nothing',
      actual: [refused.status, await stockAt(norte, a)],
      expected: [403, 0],
    });
  });
});
