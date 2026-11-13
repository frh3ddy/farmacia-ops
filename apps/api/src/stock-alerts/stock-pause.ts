import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PauseReason, Prisma, PrismaClient } from '@prisma/client';

const NOTE_MAX = 500;

const STOCKED = { soldOnlyAtLocationId: true, tracksInventory: true, isDiscontinued: true } as const;

/**
 * Why a product can't be paused, or stand in for one, at a store; null if it
 * can. Yastás services and discontinued products never alert (Yastás is its
 * own workflow), and a product only another store sells isn't sold here.
 */
function notStockedAt(p: { soldOnlyAtLocationId: string | null; tracksInventory: boolean; isDiscontinued: boolean }, locationId: string): string | null {
  if (!p.tracksInventory) return 'no lleva existencias';
  if (p.isDiscontinued) return 'está descontinuado';
  if (p.soldOnlyAtLocationId && p.soldOnlyAtLocationId !== locationId) return 'no se vende en esta sucursal';
  return null;
}

export interface PauseInput {
  productId: string;
  locationId: string;
  reason: PauseReason;
  note?: string;
  /** Only with REPLACED_BY_EQUIVALENT: the product sold instead. */
  replacedByProductId?: string;
  employeeId?: string;
}

/**
 * Pauses a product at one store: it stops alerting there and shows as paused
 * until it's resumed by hand or the store receives it. Pausing again
 * overwrites the pause and clears the last resume. Replaced by an equivalent,
 * the two products are linked as equivalents (linkEquivalents).
 */
export async function pauseProduct(prisma: PrismaClient, { productId, locationId, reason, note, replacedByProductId, employeeId }: PauseInput): Promise<void> {
  if (!Object.values(PauseReason).includes(reason)) throw new BadRequestException('Motivo de pausa no válido');
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.trim().length > NOTE_MAX)) {
    throw new BadRequestException(`La nota debe ser texto de hasta ${NOTE_MAX} caracteres`);
  }
  const store = await prisma.location.findUnique({ where: { id: locationId }, select: { isActive: true } });
  if (!store) throw new NotFoundException('Sucursal no encontrada');
  if (!store.isActive) throw new BadRequestException('La sucursal no está activa');
  const product = await prisma.product.findUnique({ where: { id: productId }, select: STOCKED });
  if (!product) throw new NotFoundException('Producto no encontrado');
  const why = notStockedAt(product, locationId);
  if (why) throw new BadRequestException(`Este producto ${why}`);
  if (replacedByProductId !== undefined && replacedByProductId !== null) {
    if (typeof replacedByProductId !== 'string') throw new BadRequestException('Producto de reemplazo no válido');
    if (reason !== 'REPLACED_BY_EQUIVALENT') throw new BadRequestException('Solo se indica un reemplazo al pausar por equivalente');
    if (replacedByProductId === productId) throw new BadRequestException('Un producto no puede reemplazarse a sí mismo');
    const replacement = await prisma.product.findUnique({ where: { id: replacedByProductId }, select: STOCKED });
    if (!replacement) throw new BadRequestException('Producto de reemplazo no encontrado');
    const whyNot = notStockedAt(replacement, locationId);
    if (whyNot) throw new BadRequestException(`El reemplazo ${whyNot}`);
  }

  const pause = {
    pausedAt: new Date(), pauseReason: reason, pauseNote: note?.trim() || null, replacedByProductId: replacedByProductId ?? null,
    pausedByEmployeeId: employeeId ?? null, resumedAt: null, resumeCause: null,
  };
  await prisma.$transaction(async (tx) => {
    await tx.productStoreStatus.upsert({
      where: { productId_locationId: { productId, locationId } },
      create: { productId, locationId, ...pause },
      update: pause,
    });
    if (replacedByProductId) await linkEquivalents(tx, productId, replacedByProductId, employeeId);
  });
}

/**
 * Makes two products equivalents: both join a new group when neither has one,
 * or the group one of them is in. Two products already in different groups
 * are left alone: merging groups would make products nobody linked
 * interchangeable at every store, so that's done on purpose (O8), never here.
 */
export async function linkEquivalents(tx: Prisma.TransactionClient, a: string, b: string, employeeId?: string): Promise<void> {
  // Locked in id order, so two links sharing a product don't each make a group and leave one product alone in it.
  await tx.$queryRaw`SELECT id FROM "Product" WHERE id IN (${a}, ${b}) ORDER BY id FOR UPDATE`;
  const products = await tx.product.findMany({ where: { id: { in: [a, b] } }, select: { id: true, equivalenceGroupId: true } });
  const groups = new Set(products.map((p) => p.equivalenceGroupId).filter((g): g is string => !!g));
  if (groups.size > 1) return;
  const groupId = [...groups][0] ?? (await tx.equivalenceGroup.create({ data: { createdByEmployeeId: employeeId ?? null } })).id;
  await tx.product.updateMany({ where: { id: { in: [a, b] }, equivalenceGroupId: null }, data: { equivalenceGroupId: groupId } });
}
