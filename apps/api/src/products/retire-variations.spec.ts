import { assert } from 'riteway/vitest';
import { ProductsService } from './products.service';

// Square: item i-jarabe sells 120 ml (discontinued) and 240 ml (kept); item
// i-gasas sells two sizes, both discontinued; v-gone is already deleted.
const variation = (id: string, itemId: string) => ({ id, type: 'ITEM_VARIATION', itemVariationData: { itemId } });
const item = (id: string, variations: string[]) => ({ id, type: 'ITEM', itemData: { variations: variations.map((v) => ({ id: v })) } });

function setup({ failDelete = false } = {}) {
  const batchDelete = vi.fn(async (_: { objectIds: string[] }) => {
    if (failDelete) throw new Error('Square is down');
    return {};
  });
  const batchGet = vi.fn(async () => ({
    objects: [variation('v-120', 'i-jarabe'), variation('v-gasas-s', 'i-gasas'), variation('v-gasas-m', 'i-gasas')],
    relatedObjects: [item('i-jarabe', ['v-120', 'v-240']), item('i-gasas', ['v-gasas-s', 'v-gasas-m'])],
  }));
  const service = new ProductsService({} as any);
  vi.spyOn(service as any, 'getSquareClient').mockReturnValue({ catalog: { batchGet, batchDelete } });
  return { service, batchDelete };
}

describe('retireVariations', () => {
  test('items with variations still for sale', async () => {
    const { service, batchDelete } = setup();
    const retired = await service.retireVariations(['v-120', 'v-gasas-s', 'v-gasas-m', 'v-gone']);
    assert({
      given: 'a discontinued variation beside one still for sale, an item whose variations are all discontinued, and one already gone',
      should: 'delete only that variation, the whole other item, and count all of them retired',
      actual: [batchDelete.mock.calls.map(([r]) => [...r.objectIds].sort()), [...retired].sort()],
      expected: [[['i-gasas', 'v-120']], ['v-120', 'v-gasas-m', 'v-gasas-s', 'v-gone']],
    });
  });

  test('Square failing', async () => {
    const { service } = setup({ failDelete: true });
    assert({
      given: 'Square failing to delete',
      should: 'retire only what was already gone',
      actual: [...(await service.retireVariations(['v-120', 'v-gone']))],
      expected: ['v-gone'],
    });
  });
});
