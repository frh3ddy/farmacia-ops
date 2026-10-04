import { SupplierService } from './supplier.service';

const simi = { id: 'sup-simi', name: 'Simi', initials: ['Simi', 'S'], contactInfo: null, isActive: true };

function setup({ byName = null as any, byInitial = [] as any[] } = {}) {
  const prisma = {
    supplier: {
      findUnique: jest.fn().mockResolvedValue(byName),
      upsert: jest.fn().mockImplementation(({ create }) => ({ id: 'sup-new', initials: [], contactInfo: null, ...create })),
    },
    $queryRaw: jest.fn().mockResolvedValue(byInitial),
  };
  return { service: new SupplierService(prisma as any), prisma };
}

describe('findOrCreateSupplier', () => {
  it('resolves a typed initial to the one supplier that owns it instead of creating a duplicate', async () => {
    const { service, prisma } = setup({ byInitial: [simi] });

    expect(await service.findOrCreateSupplier('S')).toEqual(simi);
    expect(prisma.supplier.upsert).not.toHaveBeenCalled();
  });

  it('creates a new supplier when the initial is ambiguous or unknown', async () => {
    for (const byInitial of [[], [simi, { ...simi, id: 'sup-other' }]]) {
      const { service, prisma } = setup({ byInitial });
      expect((await service.findOrCreateSupplier('S')).id).toBe('sup-new');
      expect(prisma.supplier.upsert).toHaveBeenCalled();
    }
  });

  it('prefers an exact name match over any initial', async () => {
    const { service, prisma } = setup({ byName: { id: 'sup-s' }, byInitial: [simi] });

    await service.findOrCreateSupplier('S');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.supplier.upsert).toHaveBeenCalled();
  });
});
