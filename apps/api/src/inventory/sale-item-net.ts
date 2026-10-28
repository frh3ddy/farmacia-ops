import { Prisma } from '@prisma/client';

type Amounts = { quantity: number; revenue: Prisma.Decimal; cost: Prisma.Decimal };

/**
 * What a sale item counts for in a report once its returns are taken off.
 * Returns count in the sale's period, not the day they were made.
 */
export function saleItemNet(item: { quantity: number; price: Prisma.Decimal; cost: Prisma.Decimal; returns: Amounts[] }) {
  return item.returns.reduce(
    (net, r) => ({ units: net.units - r.quantity, revenue: net.revenue.sub(r.revenue), cost: net.cost.sub(r.cost) }),
    { units: item.quantity, revenue: item.price.mul(item.quantity), cost: item.cost },
  );
}
