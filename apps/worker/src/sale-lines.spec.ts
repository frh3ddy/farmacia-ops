import { Prisma } from '@prisma/client';
import { toSaleLines, type OrderLine } from './sale-lines';
import type { MappedProduct } from './catalog.mapper';

const context = { orderId: 'o-1', squareId: 'p-1', locationId: 'SQ-CENTRO' };
const product = (productId: string): MappedProduct => ({ productId, tracksInventory: true, employeeId: null });
const yastas = (employeeId: string | null): MappedProduct => ({ productId: 'yastas', tracksInventory: false, employeeId });
const line = (catalogObjectId: string | undefined, quantity: string, amount: number): OrderLine => ({
  uid: `uid-${catalogObjectId}`,
  name: `item ${catalogObjectId}`,
  catalogObjectId,
  quantity,
  totalMoney: { amount: BigInt(amount), currency: 'MXN' },
});

const plain = (lines: ReturnType<typeof toSaleLines>) => ({
  saleItems: lines.saleItems.map((i) => ({ ...i, salePrice: i.salePrice.toString() })),
  yastasLines: lines.yastasLines.map((l) => ({ ...l, faceAmount: l.faceAmount.toString() })),
  skipped: lines.skipped.map((l) => l.name),
});

describe('toSaleLines', () => {
  it('given stock items, prices each unit as the line total ÷ quantity, in pesos', () => {
    const mappings = new Map([['v-jarabe', product('jarabe')]]);

    expect(plain(toSaleLines([line('v-jarabe', '3', 10000)], mappings, context))).toEqual({
      saleItems: [{ productId: 'jarabe', quantitySold: 3, salePrice: new Prisma.Decimal(100).div(3).toString() }],
      yastasLines: [],
      skipped: [],
    });
  });

  it('given a Yastás item, records its face amount for the employee instead of a sale item', () => {
    const mappings = new Map([['v-jarabe', product('jarabe')], ['v-yastas', yastas('emp-1')]]);

    expect(plain(toSaleLines([line('v-jarabe', '1', 5000), line('v-yastas', '1', 25000)], mappings, context))).toEqual({
      saleItems: [{ productId: 'jarabe', quantitySold: 1, salePrice: '50' }],
      yastasLines: [{ employeeId: 'emp-1', faceAmount: '250' }],
      skipped: [],
    });
  });

  it('given a line with no catalog item (a custom amount), reports it as skipped', () => {
    const mappings = new Map([['v-jarabe', product('jarabe')]]);

    expect(plain(toSaleLines([line('v-jarabe', '1', 5000), line(undefined, '1', 2000)], mappings, context)).skipped).toEqual(['item undefined']);
  });

  it('given a non-inventory mapping with no employee, fails with a validation error', () => {
    expect(() => toSaleLines([line('v-yastas', '1', 25000)], new Map([['v-yastas', yastas(null)]]), context)).toThrow(
      /flagged non-inventory \(tracksInventory=false\) but has no employeeId/,
    );
  });

  it('given a zero or unreadable quantity, fails with a validation error', () => {
    const mappings = new Map([['v-jarabe', product('jarabe')]]);

    expect(() => toSaleLines([line('v-jarabe', '0', 5000)], mappings, context)).toThrow(/quantity must be positive/);
    expect(() => toSaleLines([line('v-jarabe', 'abc', 5000)], mappings, context)).toThrow(/quantity must be positive/);
  });

  it('given a line with no price, fails with a validation error', () => {
    const noPrice = { ...line('v-jarabe', '1', 0), totalMoney: undefined };

    expect(() => toSaleLines([noPrice], new Map([['v-jarabe', product('jarabe')]]), context)).toThrow(/missing price information/);
  });

  it('given only custom-amount lines, fails because nothing can be recorded', () => {
    expect(() => toSaleLines([line(undefined, '1', 2000)], new Map(), context)).toThrow(/No valid line items found after mapping/);
  });
});
