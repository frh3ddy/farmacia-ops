import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { InventoryReceivingService } from './inventory-receiving.service';

const startDate = new Date('2026-03-01');
const endDate = new Date('2026-03-31');

function whereOf(findMany: jest.Mock) {
  return findMany.mock.calls[0][0].where;
}

describe('getAdjustmentsByLocation date range', () => {
  function setup() {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new InventoryAdjustmentService({ inventoryAdjustment: { findMany } } as any);
    return { service, findMany };
  }

  it('keeps both bounds when start and end are given', async () => {
    const { service, findMany } = setup();
    await service.getAdjustmentsByLocation('loc-1', { startDate, endDate });
    expect(whereOf(findMany).adjustedAt).toEqual({ gte: startDate, lte: endDate });
  });

  it('applies a lone start bound', async () => {
    const { service, findMany } = setup();
    await service.getAdjustmentsByLocation('loc-1', { startDate });
    expect(whereOf(findMany).adjustedAt).toEqual({ gte: startDate });
  });

  it('applies a lone end bound', async () => {
    const { service, findMany } = setup();
    await service.getAdjustmentsByLocation('loc-1', { endDate });
    expect(whereOf(findMany).adjustedAt).toEqual({ lte: endDate });
  });

  it('omits the date filter entirely when no dates are given', async () => {
    const { service, findMany } = setup();
    await service.getAdjustmentsByLocation('loc-1');
    expect(whereOf(findMany)).not.toHaveProperty('adjustedAt');
  });
});

describe('getReceivingsByLocation date range', () => {
  function setup() {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new InventoryReceivingService({ inventoryReceiving: { findMany } } as any);
    return { service, findMany };
  }

  it('keeps both bounds when start and end are given', async () => {
    const { service, findMany } = setup();
    await service.getReceivingsByLocation('loc-1', { startDate, endDate });
    expect(whereOf(findMany).receivedAt).toEqual({ gte: startDate, lte: endDate });
  });

  it('applies a lone start bound', async () => {
    const { service, findMany } = setup();
    await service.getReceivingsByLocation('loc-1', { startDate });
    expect(whereOf(findMany).receivedAt).toEqual({ gte: startDate });
  });

  it('applies a lone end bound', async () => {
    const { service, findMany } = setup();
    await service.getReceivingsByLocation('loc-1', { endDate });
    expect(whereOf(findMany).receivedAt).toEqual({ lte: endDate });
  });

  it('omits the date filter entirely when no dates are given', async () => {
    const { service, findMany } = setup();
    await service.getReceivingsByLocation('loc-1');
    expect(whereOf(findMany)).not.toHaveProperty('receivedAt');
  });
});
