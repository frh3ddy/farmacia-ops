import { BadRequestException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { stockAlertSettingsOf } from '../stock-alerts/stock-alert-settings';

/**
 * The owner's "Configurar sucursal" checklist for one open store: everyone who
 * works there has a PIN, the store has an active recurring expense of its own,
 * an opening stock count ended, and who receives from suppliers was reviewed.
 */
export async function storeSetupChecklist(prisma: PrismaClient, locationId: string) {
  const store = await prisma.location.findUnique({ where: { id: locationId }, select: { isActive: true } });
  if (!store?.isActive) throw new BadRequestException('Sucursal no encontrada');

  const [missingPin, activeRules, lastCount, settings] = await Promise.all([
    prisma.employee.findMany({
      where: { isActive: true, pin: null, assignments: { some: { locationId, isActive: true } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.recurringExpense.count({ where: { locationId, paused: false } }),
    prisma.stockCount.findFirst({ where: { locationId, endedAt: { not: null } }, orderBy: { endedAt: 'desc' }, select: { endedAt: true } }),
    stockAlertSettingsOf(prisma, locationId),
  ]);
  const endedAt = lastCount?.endedAt ?? null;
  const reviewed = settings.receivingReviewed;

  const items = [
    { key: 'EMPLOYEE_PINS', done: missingPin.length === 0, missingPin },
    { key: 'RECURRING_EXPENSES', done: activeRules > 0, activeRules },
    { key: 'STOCK_COUNT', done: endedAt !== null, endedAt },
    { key: 'RECEIVING', done: reviewed !== null, reviewed },
  ] as const;
  return { locationId, done: items.filter((i) => i.done).length, total: items.length, items };
}
