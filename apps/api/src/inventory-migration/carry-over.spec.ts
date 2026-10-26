import { InventoryMigrationService, decisionsToCarryOver } from './inventory-migration.service';

describe('decisionsToCarryOver', () => {
  it('carries approvals from any location but discards only from the same one', () => {
    // Newest first. "old" ran at this location, "elsewhere" at another one.
    const carried = decisionsToCarryOver(
      [
        { productId: 'jarabe', cutoverId: 'elsewhere', migrationStatus: 'SKIPPED' },
        { productId: 'jarabe', cutoverId: 'old', migrationStatus: 'APPROVED' },
        { productId: 'gasas', cutoverId: 'old', migrationStatus: 'SKIPPED' },
        { productId: 'gasas', cutoverId: 'elsewhere', migrationStatus: 'APPROVED' },
        { productId: 'suero', cutoverId: 'elsewhere', migrationStatus: 'SKIPPED' },
      ],
      new Set(['old']),
    );
    expect(Object.fromEntries([...carried].map(([pid, a]) => [pid, `${a.migrationStatus}@${a.cutoverId}`]))).toEqual({
      jarabe: 'APPROVED@old',
      gasas: 'SKIPPED@old',
    });
  });
});

describe('carryOverDecisions', () => {
  it('fills only unreviewed products and always skips discontinued ones', async () => {
    const prisma = {
      costApproval: {
        findMany: jest
          .fn()
          // rows already in this session: "restaurado" was restored (PENDING)
          .mockResolvedValueOnce([{ productId: 'restaurado' }])
          // earlier sessions' history
          .mockResolvedValueOnce([
            { productId: 'restaurado', cutoverId: 'old', migrationStatus: 'APPROVED', approvedCost: 5, source: 'MANUAL' },
            { productId: 'jarabe', cutoverId: 'elsewhere', migrationStatus: 'APPROVED', approvedCost: 12, source: 'MANUAL' },
            { productId: 'baja', cutoverId: 'elsewhere', migrationStatus: 'APPROVED', approvedCost: 3, source: 'MANUAL' },
          ]),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      extractionSession: { findMany: jest.fn().mockResolvedValue([{ id: 'old', cutoverId: 'old' }]) },
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'baja' }]) },
    };
    const service = new InventoryMigrationService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    const carried = await (service as any).carryOverDecisions('new', ['loc-centro'], ['restaurado', 'jarabe', 'baja', 'nuevo']);

    expect([...carried].sort()).toEqual(['baja', 'jarabe']);
    const rows = prisma.costApproval.createMany.mock.calls[0][0].data;
    expect(rows.map((r: any) => [r.productId, r.migrationStatus, r.cutoverId])).toEqual([
      ['baja', 'SKIPPED', 'new'],
      ['jarabe', 'APPROVED', 'new'],
    ]);
    expect(rows[1].approvedCost).toBe(12);
  });
});
