import { InventoryMigrationService, extractionProgress } from './inventory-migration.service';

// One location; p1 has two variations (one with both a location-scoped and a
// global mapping), p2 and p3 one each. p2 was already approved in session s1.
function setup() {
  const prisma = {
    location: {
      findMany: jest.fn().mockResolvedValue([{ id: 'loc-centro', name: 'Centro', squareId: 'sq-centro' }]),
    },
    catalogMapping: {
      // Already in the DB's orderBy order: variation asc, location-scoped first.
      findMany: jest.fn().mockResolvedValue([
        { squareVariationId: 'v-a', productId: 'p1', locationId: 'loc-centro' },
        { squareVariationId: 'v-a', productId: 'p-stale-global', locationId: null },
        { squareVariationId: 'v-b', productId: 'p2', locationId: null },
        { squareVariationId: 'v-c', productId: 'p1', locationId: null },
        { squareVariationId: 'v-d', productId: 'p3', locationId: null },
      ]),
    },
    costApproval: {
      findMany: jest.fn().mockResolvedValue([{ productId: 'p2' }]),
    },
  };
  const squareInventory = {
    fetchSquareInventory: jest.fn().mockResolvedValue([{ catalogObjectId: 'v-a', quantity: 3 }]),
  };
  const service = new InventoryMigrationService(prisma as any, squareInventory as any, {} as any, {} as any, {} as any, {} as any);
  return { service, prisma };
}

const locationById = new Map([['loc-centro', { id: 'loc-centro', name: 'Centro', squareId: 'sq-centro' }]]);

describe('extractionProgress', () => {
  it('is not complete halfway through, whatever the batch size', () => {
    // The prod incident: 4111 products, 2100 reviewed, batch size 50.
    expect(extractionProgress(4111, 2011, 50)).toEqual({
      processedItems: 2100,
      currentBatch: 43,
      totalBatches: 83,
      isComplete: false,
    });
  });

  it('is complete only when nothing remains', () => {
    expect(extractionProgress(100, 0, 50)).toEqual({ processedItems: 100, currentBatch: 2, totalBatches: 2, isComplete: true });
  });
});

describe('getExtractionQueue', () => {
  it('keeps catalog order, groups variations per product, and drops reviewed products', async () => {
    const { service } = setup();
    const queue = await (service as any).getExtractionQueue(['loc-centro'], locationById, 's1');

    expect(queue.totalProducts).toBe(3);
    expect(queue.remainingProductIds).toEqual(['p1', 'p3']);
    // Location-scoped mapping wins over the global one for the same variation.
    expect(queue.itemsByProduct.has('p-stale-global')).toBe(false);
    expect(queue.itemsByProduct.get('p1').map((i: any) => i.squareInventoryItem.catalogObjectId)).toEqual(['v-a', 'v-c']);
    expect(queue.itemsByProduct.get('p1')[0].squareInventoryItem.quantity).toBe(3);
  });

  it('asks only for inventory-tracked, non-Yastás mappings in a stable order', async () => {
    const { service, prisma } = setup();
    await (service as any).getExtractionQueue(['loc-centro'], locationById, 's1');

    const args = prisma.catalogMapping.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ employeeId: null, product: { tracksInventory: true } });
    expect(args.orderBy[0]).toEqual({ squareVariationId: 'asc' });
    expect(prisma.costApproval.findMany.mock.calls[0][0].where).toEqual({
      cutoverId: 's1',
      migrationStatus: { in: ['APPROVED', 'SKIPPED'] },
    });
  });
});

describe('executeInventoryMigration gate', () => {
  it('refuses to start while the extraction session has unreviewed products', async () => {
    const { service } = setup();
    jest.spyOn(service as any, 'validateCutoverInput').mockResolvedValue({ valid: true, errors: [] });

    await expect(
      service.executeInventoryMigration(
        { cutoverDate: new Date(), locationIds: ['loc-centro'], costBasis: 'DESCRIPTION', ownerApproved: true } as any,
        [],
        50,
        null,
        's1',
      ),
    ).rejects.toThrow('faltan 2 de 3 productos por revisar');
  });
});
