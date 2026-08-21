/**
 * Pure transfer logic — no DB access. A transfer must preserve FIFO lot
 * identity across the move: each source lot touched becomes its own
 * destination lot, keeping its own cost AND its own original receivedAt
 * (never blended into one average, unlike break-bulk) — otherwise
 * transferred stock looks "new" and gets consumed last at the destination,
 * corrupting FIFO ordering there.
 */

export type ConsumedBatchForTransfer = {
  inventoryId: string;
  quantity: number;
  unitCost: number;
  receivedAt: Date;
};

export type TransferLineDraft = {
  sourceInventoryId: string;
  quantity: number;
  unitCost: number;
  originalReceivedAt: Date;
};

/** One TransferLine per source lot consumed while shipping — 1:1, nothing blended. */
export function buildTransferLines(consumedBatches: ConsumedBatchForTransfer[]): TransferLineDraft[] {
  return consumedBatches.map((b) => ({
    sourceInventoryId: b.inventoryId,
    quantity: b.quantity,
    unitCost: b.unitCost,
    originalReceivedAt: b.receivedAt,
  }));
}

/** Defaults to a full receipt (quantity shipped) unless an explicit partial override is given. */
export function resolveQuantityReceived(quantityShipped: number, override?: number): number {
  return override ?? quantityShipped;
}

/** quantity - quantityReceived; the shortfall is a loss, never silently reconciled away. */
export function discrepancy(quantityShipped: number, quantityReceived: number): number {
  return quantityShipped - quantityReceived;
}
