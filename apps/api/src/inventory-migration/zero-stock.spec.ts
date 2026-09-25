import { InventoryMigrationService } from './inventory-migration.service';

// Two Square-linked locations; variation "v-global" is mapped everywhere,
// "v-centro" only at Centro.
function setup() {
  const prisma = {
    location: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'loc-centro', name: 'Centro', squareId: 'sq-centro' },
        { id: 'loc-norte', name: 'Norte', squareId: 'sq-norte' },
      ]),
    },
    catalogMapping: {
      findMany: jest.fn().mockResolvedValue([
        { squareVariationId: 'v-global', locationId: null },
        { squareVariationId: 'v-centro', locationId: 'loc-centro' },
      ]),
    },
  };
  const squareInventory = {
    fetchCounts: jest.fn().mockResolvedValue([
      { catalogObjectId: 'v-global', locationId: 'sq-centro', quantity: 2 },
      { catalogObjectId: 'v-centro', locationId: 'sq-centro', quantity: 1 },
      { catalogObjectId: 'v-global', locationId: 'sq-norte', quantity: 4 },
      // Not mapped at Norte — must not leak into Norte's total.
      { catalogObjectId: 'v-centro', locationId: 'sq-norte', quantity: 9 },
    ]),
    zeroCounts: jest.fn().mockResolvedValue(undefined),
  };
  const service = new InventoryMigrationService(prisma as any, squareInventory as any, {} as any, {} as any, {} as any, {} as any);
  return { service, squareInventory };
}

describe('getProductStockByLocation', () => {
  it('sums only the variations mapped at each location', async () => {
    const { service } = setup();
    expect(await service.getProductStockByLocation('p1')).toEqual([
      { locationId: 'loc-centro', locationName: 'Centro', quantity: 3 },
      { locationId: 'loc-norte', locationName: 'Norte', quantity: 4 },
    ]);
  });
});

describe('zeroProductStock', () => {
  it('zeroes every mapped variation at the selected locations only', async () => {
    const { service, squareInventory } = setup();
    await service.zeroProductStock('p1', ['loc-centro']);
    expect(squareInventory.zeroCounts).toHaveBeenCalledWith([
      { catalogObjectId: 'v-global', locationId: 'sq-centro' },
      { catalogObjectId: 'v-centro', locationId: 'sq-centro' },
    ]);
  });

  it('rejects an unknown location without touching Square', async () => {
    const { service, squareInventory } = setup();
    await expect(service.zeroProductStock('p1', ['loc-centro', 'loc-ghost'])).rejects.toThrow('loc-ghost');
    expect(squareInventory.zeroCounts).not.toHaveBeenCalled();
  });
});
