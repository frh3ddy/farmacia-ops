import { Prisma } from '@prisma/client';
import { LocationsService } from './locations.service';

function setup(squareLocations: any[], stale: { id: string }[] = []) {
  const prisma = {
    location: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue(stale),
    },
  };
  const service = new LocationsService(prisma as any);
  (service as any).squareClient = { locations: { list: jest.fn().mockResolvedValue({ locations: squareLocations }) } };
  return { service, prisma };
}

const fkError = () =>
  new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', { code: 'P2003', clientVersion: 'test' });

describe('syncLocationsFromSquare', () => {
  it('mirrors Square status into isActive', async () => {
    const { service, prisma } = setup([{ id: 'sq-closed', name: 'Closed', status: 'INACTIVE' }]);
    await service.syncLocationsFromSquare();
    expect(prisma.location.create).toHaveBeenCalledWith({ data: expect.objectContaining({ squareId: 'sq-closed', isActive: false }) });
  });

  it('deletes a location missing from Square, or deactivates it when it has history', async () => {
    const { service, prisma } = setup([{ id: 'sq-live', name: 'Live', status: 'ACTIVE' }], [{ id: 'empty' }, { id: 'with-sales' }]);
    prisma.location.delete.mockImplementation(({ where }: any) =>
      where.id === 'with-sales' ? Promise.reject(fkError()) : Promise.resolve({}),
    );

    const result = await service.syncLocationsFromSquare();

    expect(prisma.location.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { squareId: { not: null, notIn: ['sq-live'] } } }),
    );
    expect(result).toMatchObject({ removed: 1, deactivated: 1, errors: [] });
    expect(prisma.location.update).toHaveBeenCalledWith({ where: { id: 'with-sales' }, data: { isActive: false } });
  });

  it('never prunes when Square returns no locations', async () => {
    const { service, prisma } = setup([], [{ id: 'would-be-wiped' }]);
    await service.syncLocationsFromSquare();
    expect(prisma.location.findMany).not.toHaveBeenCalled();
    expect(prisma.location.delete).not.toHaveBeenCalled();
  });
});
