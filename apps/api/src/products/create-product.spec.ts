import { assert } from 'riteway/vitest';
import { BadRequestException } from '@nestjs/common';
import { ProductsController } from './products.controller';

/** The controller over a recorded service and Prisma, for a manager at Centro. */
function createRoute(assertCreatable = vi.fn().mockResolvedValue({})) {
  const service = { assertCreatable, createProduct: vi.fn().mockResolvedValue({ message: 'ok' }) };
  const prisma = {
    laboratory: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'lab' }) },
    activeIngredient: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'ing' }) },
    medicationDefinition: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'def' }) },
  };
  const controller = new ProductsController(service as any, prisma as any, {} as any, {} as any);
  const req = { currentLocation: { locationId: 'centro', role: 'MANAGER' } } as any;
  const send = (body: object) =>
    controller.createProduct({ name: 'Paracetamol', sellingPrice: 30, ...body } as any, req).then(
      () => 201,
      (e: any) => e.getStatus(),
    );
  const created = () => [prisma.laboratory.create, prisma.activeIngredient.create, prisma.medicationDefinition.create].map((f) => f.mock.calls.length);
  return { service, send, created };
}

const medication = { name: 'Paracetamol', form: 'TABLET', route: 'ORAL', strength: '500 mg' };

describe('ProductsController.createProduct', () => {
  test('a medication without its ingredient list', async () => {
    const { service, send, created } = createRoute();
    const status = await send({ medication });

    assert({
      given: 'inline medication info with no activeIngredients array',
      should: 'answer 400 instead of 500, and create nothing',
      actual: [status, created(), service.createProduct.mock.calls.length],
      expected: [400, [0, 0, 0], 0],
    });
  });

  test('a request the service refuses', async () => {
    const { send, created } = createRoute(vi.fn().mockRejectedValue(new BadRequestException('El costo debe ser un número de 0 o más')));
    const status = await send({ costPrice: 'abc', labName: 'Lab Nuevo', medication: { ...medication, activeIngredients: [{ name: 'Paracetamol' }] } });

    assert({
      given: 'a new laboratory and medication on a request with a bad cost',
      should: 'refuse it before creating the laboratory, ingredient or medication definition',
      actual: [status, created()],
      expected: [400, [0, 0, 0]],
    });
  });
});
