import { assert } from 'riteway/vitest';
import { ProductsService } from './products.service';

/** A Square item as Square returns it: sold at two stores, with a custom attribute and an image. */
const item = () => ({
  type: 'ITEM',
  id: 'ITEM-1',
  version: BigInt(9),
  presentAtAllLocations: false,
  presentAtLocationIds: ['SQ-CENTRO', 'SQ-NORTE'],
  customAttributeValues: { marca: { name: 'Marca', stringValue: 'Genérico' } },
  itemData: { name: 'Viejo', imageIds: ['IMG-1'], variations: [{ type: 'ITEM_VARIATION', id: 'VAR-1' }] },
});

describe('ProductsService.renameProductInSquare', () => {
  test('a new name', async () => {
    const products = new ProductsService({} as any);
    const get = vi.fn(async ({ objectId }: { objectId: string }) =>
      objectId === 'VAR-1' ? { object: { type: 'ITEM_VARIATION', id: 'VAR-1', itemVariationData: { itemId: 'ITEM-1' } } } : { object: item() },
    );
    const upsert = vi.fn().mockResolvedValue({});
    products['squareClient'] = { catalog: { object: { get, upsert } } } as any;

    await products.renameProductInSquare('VAR-1', 'Nuevo');

    assert({
      given: 'a rename of the item behind a variation',
      should: 'send the item back as Square returned it with only its name changed',
      actual: upsert.mock.calls[0][0].object,
      expected: { ...item(), itemData: { ...item().itemData, name: 'Nuevo' } },
    });
  });
});
