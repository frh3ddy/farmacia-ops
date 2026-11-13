import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PauseReason, PrismaClient } from '@prisma/client';

const NOTE_MAX = 500;

export interface PauseInput {
  productId: string;
  locationId: string;
  reason: PauseReason;
  note?: string;
  employeeId?: string;
}

/**
 * Pauses a product at one store: it stops alerting there and shows as paused
 * until it's resumed by hand or the store receives it. Pausing again
 * overwrites the pause and clears the last resume.
 */
export async function pauseProduct(prisma: PrismaClient, { productId, locationId, reason, note, employeeId }: PauseInput): Promise<void> {
  if (!Object.values(PauseReason).includes(reason)) throw new BadRequestException('Motivo de pausa no válido');
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.trim().length > NOTE_MAX)) {
    throw new BadRequestException(`La nota debe ser texto de hasta ${NOTE_MAX} caracteres`);
  }
  const store = await prisma.location.findUnique({ where: { id: locationId }, select: { isActive: true } });
  if (!store) throw new NotFoundException('Sucursal no encontrada');
  if (!store.isActive) throw new BadRequestException('La sucursal no está activa');
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { soldOnlyAtLocationId: true, tracksInventory: true, isDiscontinued: true } });
  if (!product) throw new NotFoundException('Producto no encontrado');
  // Neither alerts (Yastás is its own workflow), so a pause would mean nothing.
  if (!product.tracksInventory) throw new BadRequestException('Este producto no lleva existencias');
  if (product.isDiscontinued) throw new BadRequestException('Este producto está descontinuado');
  if (product.soldOnlyAtLocationId && product.soldOnlyAtLocationId !== locationId) {
    throw new BadRequestException('Esta sucursal no vende este producto');
  }

  const pause = { pausedAt: new Date(), pauseReason: reason, pauseNote: note?.trim() || null, pausedByEmployeeId: employeeId ?? null, resumedAt: null, resumeCause: null };
  await prisma.productStoreStatus.upsert({
    where: { productId_locationId: { productId, locationId } },
    create: { productId, locationId, ...pause },
    update: pause,
  });
}
