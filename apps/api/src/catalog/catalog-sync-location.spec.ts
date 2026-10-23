import { CatalogService, productByVariation } from './catalog.service';

// A location sync for a SKU-less Square variation that is already mapped
// globally: it must reuse that product, not create a duplicate.
function setup() {
  const existing = { id: 'p-aspirina', name: 'Aspirina', sku: null, squareDataSyncedAt: new Date() };
  const tx = {
    product: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    catalogMapping: { create: jest.fn(), update: jest.fn() },
  };
  const prisma = {
    location: { findUnique: jest.fn().mockResolvedValue({ id: 'loc-norte', name: 'Norte' }) },
    catalogMapping: {
      findMany: jest
        .fn()
        // 1st: mappings scoped to this location — none yet.
        .mockResolvedValueOnce([])
        // 2nd: the same variation in any scope — the global mapping.
        .mockResolvedValueOnce([{ squareVariationId: 'v1', locationId: null, product: existing }]),
    },
    product: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const service = new CatalogService(prisma as any);
  jest.spyOn(service as any, 'getSquareClient').mockReturnValue({
    catalog: {
      search: jest.fn().mockResolvedValue({
        objects: [{ id: 'v1', type: 'ITEM_VARIATION', itemVariationData: { name: 'Regular', itemId: 'i1' } }],
      }),
      batchGet: jest.fn().mockResolvedValue({ objects: [], relatedObjects: [] }),
    },
  });
  return { service, tx };
}

describe('syncSquareCatalog by location', () => {
  it('maps a globally-mapped, SKU-less variation to its existing product', async () => {
    const { service, tx } = setup();

    const result = await service.syncSquareCatalog('loc-norte', false);

    expect(result.errors).toEqual([]);
    expect(tx.product.create).not.toHaveBeenCalled();
    expect(tx.catalogMapping.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ squareVariationId: 'v1', productId: 'p-aspirina', locationId: 'loc-norte' }),
    });
  });
});

describe('productByVariation', () => {
  it('prefers the global mapping over a location-scoped one', () => {
    const map = productByVariation([
      { squareVariationId: 'v1', locationId: 'loc-sur', product: 'scoped' },
      { squareVariationId: 'v1', locationId: null, product: 'global' },
      { squareVariationId: 'v2', locationId: 'loc-sur', product: 'only-scoped' },
    ]);
    expect(Object.fromEntries(map)).toEqual({ v1: 'global', v2: 'only-scoped' });
  });
});
