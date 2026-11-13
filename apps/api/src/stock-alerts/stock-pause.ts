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
export async function pauseProduct(prisma: PrismaClient, input: PauseInput): Promise<void> {
  await checkPause(prisma, input);
  await prisma.$transaction(async (tx) => {
    await writePause(tx, input);
    if (input.replacedByProductId) await linkEquivalents(tx, input.productId, input.replacedByProductId, input.employeeId);
  });
}

const BULK_MAX = 200;

export interface BulkPauseInput {
  productIds: string[];
  locationId: string;
  reason: PauseReason;
  employeeId?: string;
}

/**
 * Pauses several products at one store with one reason: all of them, or none
 * if any is refused. A refusal names the product and carries its id, so the
 * phone can point at it. The store and the products are read once.
 */
export async function pauseProducts(prisma: PrismaClient, { productIds, ...pause }: BulkPauseInput): Promise<void> {
  if (!Array.isArray(productIds) || !productIds.length || productIds.length > BULK_MAX || productIds.some((id) => typeof id !== 'string')) {
    throw new BadRequestException(`Indica de 1 a ${BULK_MAX} productos`);
  }
  checkReasonAndNote(pause);
  await checkStore(prisma, pause.locationId);
  const ids = [...new Set(productIds)];
  const found = new Map((await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, ...STOCKED } })).map((p) => [p.id, p]));
  for (const productId of ids) {
    const product = found.get(productId);
    if (!product) throw new NotFoundException({ success: false, message: 'Producto no encontrado', productId });
    const why = notStockedAt(product, pause.locationId);
    if (why) throw new BadRequestException({ success: false, message: `${product.name}: este producto ${why}`, productId });
  }
  await prisma.$transaction(async (tx) => {
    for (const productId of ids) await writePause(tx, { productId, ...pause });
  });
}

/** Refuses a pause that can't be saved: bad input, an unknown or inactive store, a product that can't be paused there, or a bad replacement. */
async function checkPause(prisma: PrismaClient, { productId, locationId, reason, note, replacedByProductId }: PauseInput): Promise<void> {
  checkReasonAndNote({ reason, note });
  await checkStore(prisma, locationId);
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
}

function checkReasonAndNote({ reason, note }: { reason: PauseReason; note?: string }): void {
  if (!Object.values(PauseReason).includes(reason)) throw new BadRequestException('Motivo de pausa no válido');
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.trim().length > NOTE_MAX)) {
    throw new BadRequestException(`La nota debe ser texto de hasta ${NOTE_MAX} caracteres`);
  }
}

async function checkStore(prisma: PrismaClient, locationId: string): Promise<void> {
  const store = await prisma.location.findUnique({ where: { id: locationId }, select: { isActive: true } });
  if (!store) throw new NotFoundException('Sucursal no encontrada');
  if (!store.isActive) throw new BadRequestException('La sucursal no está activa');
}

/** Saves a checked pause, overwriting any earlier one and clearing the last resume. */
async function writePause(tx: Prisma.TransactionClient, { productId, locationId, reason, note, replacedByProductId, employeeId }: PauseInput): Promise<void> {
  const pause = {
    pausedAt: new Date(), pauseReason: reason, pauseNote: note?.trim() || null, replacedByProductId: replacedByProductId ?? null,
    pausedByEmployeeId: employeeId ?? null, resumedAt: null, resumeCause: null,
  };
  await tx.productStoreStatus.upsert({
    where: { productId_locationId: { productId, locationId } },
    create: { productId, locationId, ...pause },
    update: pause,
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
