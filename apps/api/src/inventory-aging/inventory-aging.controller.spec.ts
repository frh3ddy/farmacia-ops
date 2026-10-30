import { assert } from 'riteway/vitest';
import { InventoryAgingController } from './inventory-aging.controller';
import { ROLES_KEY } from '../auth/guards/auth.guard';

/** A Prisma Decimal as far as the controller uses it. */
const decimal = (value: number) => ({ toNumber: () => value });

/** One product expiring at Centro, as the aging service returns it. */
const expiringAnalysis = () => ({
  productId: 'p1',
  productName: 'Amoxicilina 500mg',
  sku: '750100',
  totalUnits: 12,
  totalCashAtRisk: decimal(150),
  batchCount: 1,
  expiredCount: 0,
  soonestExpiryDate: new Date('2026-11-15T18:00:00.000Z'),
  soonestDaysUntilExpiry: 16,
  severity: 'HIGH',
  batches: [{
    batchId: 'b1', receivingId: 'r1', quantity: 12, unitCost: decimal(12.5), cashValue: decimal(150),
    expiryDate: new Date('2026-11-15T18:00:00.000Z'), daysUntilExpiry: 16, isExpired: false,
    batchNumber: 'L-1', supplierName: 'Nadro', receivedAt: new Date('2026-09-01T18:00:00.000Z'),
  }],
});

function setup() {
  const service = { getExpiringProducts: vi.fn().mockResolvedValue([expiringAnalysis()]) };
  const controller = new InventoryAgingController(service as any);
  const requestAs = (role: string) => {
    const centro = { locationId: 'centro', role, isActive: true };
    return { currentLocation: centro, accessibleLocations: [centro] } as any; // fixture: only the fields the controller reads
  };
  const expiringAs = (role: string) => controller.getExpiringProducts(requestAs(role), 'centro', '90', 'true') as Promise<any>;
  return { expiringAs };
}

const rolesOf = (target: object) => Reflect.getMetadata(ROLES_KEY, target) as string[];

describe('InventoryAgingController roles', () => {
  test('who may open each route', () => {
    assert({
      given: 'the expiring route and the rest of the aging routes',
      should: 'let a cashier see what is about to expire, and keep the cost views to owner, manager and accountant',
      actual: [rolesOf(InventoryAgingController.prototype.getExpiringProducts), rolesOf(InventoryAgingController)],
      expected: [['OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER'], ['OWNER', 'MANAGER', 'ACCOUNTANT']],
    });
  });
});

describe('InventoryAgingController.getExpiringProducts', () => {
  test('a cashier', async () => {
    const { expiringAs } = setup();
    const { products: [product], summary } = await expiringAs('CASHIER');

    assert({
      given: 'a cashier opening the expiring products',
      should: 'show what expires and when, without anything the pharmacy paid',
      actual: [
        'totalCashAtRisk' in product,
        'unitCost' in product.batches[0],
        'cashValue' in product.batches[0],
        'totalCashAtRisk' in summary,
        [product.totalUnits, product.soonestDaysUntilExpiry, product.batches[0].quantity, product.batches[0].batchNumber, summary.highCount],
      ],
      expected: [false, false, false, false, [12, 16, 12, 'L-1', 1]],
    });
  });

  test('an owner', async () => {
    const { expiringAs } = setup();
    const { products: [product], summary } = await expiringAs('OWNER');

    assert({
      given: 'an owner opening the expiring products',
      should: 'keep the costs',
      actual: [product.totalCashAtRisk, product.batches[0].unitCost, product.batches[0].cashValue, summary.totalCashAtRisk],
      expected: [150, 12.5, 150, 150],
    });
  });
});
