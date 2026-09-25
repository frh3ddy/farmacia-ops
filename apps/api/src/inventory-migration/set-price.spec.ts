import { InventoryMigrationService } from './inventory-migration.service';
import { SquareInventoryService } from './square-inventory.service';

describe('SquareInventoryService.setVariationPrice', () => {
  function setup() {
    const upsert = jest.fn().mockResolvedValue({});
    const service = new SquareInventoryService();
    (service as any).squareClient = {
      catalog: {
        object: {
          get: jest.fn().mockResolvedValue({
            object: {
              type: 'ITEM_VARIATION',
              id: 'v1',
              version: BigInt(7),
              itemVariationData: {
                itemId: 'item1',
                trackInventory: true,
                priceMoney: { amount: BigInt(1000), currency: 'MXN' },
                locationOverrides: [
                  { locationId: 'sq-a', priceMoney: { amount: BigInt(1200), currency: 'MXN' }, trackInventory: true },
                ],
              },
            },
          }),
          upsert,
        },
      },
    };
    const sent = () => upsert.mock.calls[0][0].object;
    return { service, sent };
  }

  it('all locations: sets the base price and drops override prices, keeping other fields', async () => {
    const { service, sent } = setup();
    await service.setVariationPrice('v1', 1500, 'MXN', null);
    expect(sent().version).toBe(BigInt(7));
    expect(sent().itemVariationData).toMatchObject({
      itemId: 'item1',
      trackInventory: true,
      priceMoney: { amount: BigInt(1500), currency: 'MXN' },
      locationOverrides: [{ locationId: 'sq-a', trackInventory: true }],
    });
    expect(sent().itemVariationData.locationOverrides[0].priceMoney).toBeUndefined();
  });

  it('subset: leaves the base price and writes overrides for just those locations', async () => {
    const { service, sent } = setup();
    await service.setVariationPrice('v1', 1500, 'MXN', ['sq-a', 'sq-b']);
    const data = sent().itemVariationData;
    expect(data.priceMoney.amount).toBe(BigInt(1000));
    expect(data.locationOverrides).toEqual([
      { locationId: 'sq-a', trackInventory: true, pricingType: 'FIXED_PRICING', priceMoney: { amount: BigInt(1500), currency: 'MXN' } },
      { locationId: 'sq-b', pricingType: 'FIXED_PRICING', priceMoney: { amount: BigInt(1500), currency: 'MXN' } },
    ]);
  });
});

describe('InventoryMigrationService.setProductPrice', () => {
  function setup(mappings: { squareVariationId: string; locationId: string | null }[]) {
    const prisma = {
      location: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'loc-a', name: 'A', squareId: 'sq-a' },
          { id: 'loc-b', name: 'B', squareId: 'sq-b' },
        ]),
      },
      catalogMapping: { findMany: jest.fn().mockResolvedValue(mappings), updateMany: jest.fn() },
    };
    const squareInventory = {
      batchFetchSquareCatalogObjects: jest
        .fn()
        .mockResolvedValue(new Map([['v1', { variationPriceCents: 1000, variationCurrency: 'MXN' }]])),
      resolvePriceForLocation: jest.fn().mockReturnValue({ priceCents: 1000, currency: 'MXN' }),
      setVariationPrice: jest.fn().mockResolvedValue(undefined),
    };
    const service = new InventoryMigrationService(prisma as any, squareInventory as any, {} as any, {} as any, {} as any, {} as any);
    return { service, prisma, squareInventory };
  }

  it('every location selected → base price, and the local price cache is updated', async () => {
    const { service, prisma, squareInventory } = setup([{ squareVariationId: 'v1', locationId: null }]);
    await service.setProductPrice('p1', 1500, ['loc-a', 'loc-b']);
    expect(squareInventory.setVariationPrice).toHaveBeenCalledWith('v1', 1500, 'MXN', null);
    expect(prisma.catalogMapping.updateMany).toHaveBeenCalled();
  });

  it('one location selected → override there only, cache untouched', async () => {
    const { service, prisma, squareInventory } = setup([{ squareVariationId: 'v1', locationId: null }]);
    await service.setProductPrice('p1', 1500, ['loc-b']);
    expect(squareInventory.setVariationPrice).toHaveBeenCalledWith('v1', 1500, 'MXN', ['sq-b']);
    expect(prisma.catalogMapping.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a product with several variations', async () => {
    const { service, squareInventory } = setup([
      { squareVariationId: 'v1', locationId: null },
      { squareVariationId: 'v2', locationId: null },
    ]);
    await expect(service.setProductPrice('p1', 1500, ['loc-a'])).rejects.toThrow('2 Square variations');
    expect(squareInventory.setVariationPrice).not.toHaveBeenCalled();
  });
});
