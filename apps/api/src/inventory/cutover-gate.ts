import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * Refuses a stock movement at a location whose cutover hasn't finished, or one
 * dated on or before it. Finishing a location's cutover writes its lock; until
 * then the cutover will set the location's opening stock from Square's counts,
 * which would count the movement a second time (or drop it).
 */
export async function assertCutOver(prisma: Pick<Prisma.TransactionClient, 'cutoverLock'>, locationId: string, at: Date = new Date()): Promise<void> {
  const lock = await prisma.cutoverLock.findFirst({
    where: { OR: [{ locationId }, { locationId: null }], isLocked: true },
    orderBy: { cutoverDate: 'desc' },
  });
  if (!lock) {
    throw new BadRequestException(
      'Esta sucursal aún no ha hecho su corte. Los movimientos de inventario se podrán registrar cuando termine.'
    );
  }
  if (at <= lock.cutoverDate) {
    throw new BadRequestException(
      'No se pueden registrar ajustes con fecha anterior al corte: el inventario de esta sucursal está cerrado hasta esa fecha.'
    );
  }
}
