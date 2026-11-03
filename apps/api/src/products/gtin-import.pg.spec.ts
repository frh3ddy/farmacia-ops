/**
 * The one-time barcode import against a real Postgres engine (see
 * testing/pglite.ts) and a recorded Square catalog.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { importGtinFromSquare } from './gtin-import';

let prisma: PrismaService;
let stop: () => Promise<void>;
let centro: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } }));
}, 120_000);

afterAll(() => stop?.());

/** A Square catalog where each variation id carries the given upc. */
const squareWith = (upcs: Record<string, string>) => {
  const batchGet = vi.fn(async ({ objectIds }: { objectIds: string[] }) => ({
    objects: objectIds.filter((id) => id in upcs).map((id) => ({ type: 'ITEM_VARIATION', id, itemVariationData: { upc: upcs[id] } })),
  }));
  return { client: { catalog: { batchGet } } as any, batchGet };
};

const mapped = async (name: string, variationId: string, gtin?: string) => {
  const product = await prisma.product.create({ data: { name, gtin } });
  await prisma.catalogMapping.create({ data: { productId: product.id, locationId: centro, squareVariationId: variationId } });
  return product.id;
};

const gtinOf = async (id: string) => (await prisma.product.findUnique({ where: { id } }))?.gtin;

describe('importGtinFromSquare', () => {
  test('a dry run', async () => {
    const id = await mapped('Buscapina', 'VAR-DRY', undefined);
    const { client } = squareWith({ 'VAR-DRY': '3664798067460' });
    const result = await importGtinFromSquare(prisma, client, { save: false });

    assert({
      given: 'a product whose Square variation has a barcode, imported without save',
      should: 'count it as one to save and save nothing',
      actual: [result.toSave >= 1, result.saved, await gtinOf(id)],
      expected: [true, 0, null],
    });
  });

  test('saving', async () => {
    const id = await mapped('Gel', 'VAR-SAVE');
    const kept = await mapped('Ya tiene', 'VAR-KEEP', '7500000000001');
    const placeholder = await prisma.product.create({ data: { name: 'Sin Square' } });
    await prisma.catalogMapping.create({ data: { productId: placeholder.id, locationId: centro, squareVariationId: `local_${placeholder.id}` } });
    const { client, batchGet } = squareWith({ 'VAR-SAVE': '7501234567890', 'VAR-KEEP': '7509999999999' });
    await importGtinFromSquare(prisma, client, { save: true });

    assert({
      given: 'an import with save, a product that already has a barcode, and one not in Square',
      should: "save the new barcode, keep the existing one, and never ask Square about a local placeholder",
      actual: [await gtinOf(id), await gtinOf(kept), batchGet.mock.calls.flatMap(([r]) => r.objectIds).some((v) => v.startsWith('local_'))],
      expected: ['7501234567890', '7500000000001', false],
    });
  });

  test('variations that disagree', async () => {
    const product = await prisma.product.create({ data: { name: 'Dos códigos' } });
    for (const v of ['VAR-X1', 'VAR-X2']) await prisma.catalogMapping.create({ data: { productId: product.id, locationId: centro, squareVariationId: v } });
    const { client } = squareWith({ 'VAR-X1': '7501111111111', 'VAR-X2': '7502222222222' });
    const result = await importGtinFromSquare(prisma, client, { save: true });

    assert({
      given: 'a product mapped to two variations with different barcodes',
      should: 'leave it empty and list it by name with both barcodes',
      actual: [await gtinOf(product.id), result.conflicts.find((c) => c.productId === product.id)],
      expected: [null, { productId: product.id, name: 'Dos códigos', upcs: ['7501111111111', '7502222222222'] }],
    });
  });
});
