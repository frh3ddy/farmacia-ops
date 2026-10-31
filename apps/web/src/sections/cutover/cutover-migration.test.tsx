import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionSelectorModal } from "./components/SessionSelectorModal";
import { ReportPhase } from "./phases/ReportPhase";
import type { ExtractionSessionSummary, MigrationResult } from "../../lib/cutover/types";

const session = (id: string, status: ExtractionSessionSummary["status"]): ExtractionSessionSummary => ({
  id,
  locationIds: ["loc-oriente"],
  currentBatch: 1,
  totalItems: 4106,
  processedItems: status === "COMPLETED" ? 4106 : 100,
  batchSize: 50,
  status,
  createdAt: "2026-10-29T18:00:00Z",
  updatedAt: "2026-10-29T18:00:00Z",
});

describe("SessionSelectorModal", () => {
  it("offers to migrate from a finished session and to continue one in progress", () => {
    const onMigrate = vi.fn();
    const onResume = vi.fn();
    render(
      <SessionSelectorModal
        show
        sessions={[session("s-done", "COMPLETED"), session("s-open", "IN_PROGRESS")]}
        currentBatchSize={50}
        onResume={onResume}
        onMigrate={onMigrate}
        onStartNew={() => undefined}
        onClose={() => undefined}
      />,
    );
    fireEvent.click(screen.getByText("Migrar"));
    fireEvent.click(screen.getByText("Continuar"));
    expect([onMigrate.mock.calls, onResume.mock.calls]).toEqual([[["s-done"]], [["s-open"]]]);
  });
});

describe("ReportPhase", () => {
  const leftOut: MigrationResult = {
    cutoverId: "c-1",
    cutoverDate: "2026-10-29T00:00:00Z",
    locationsProcessed: 0,
    productsProcessed: 3,
    openingBalancesCreated: 3,
    errors: [],
    warnings: [],
    needsConfirmation: true,
    leftOut: [{ productId: "p-2", productName: "Jarabe 120 ml", locationId: "loc-oriente", reason: "Sin costo aprobado" }],
  };

  it("lists products left without stock and locks only when the owner confirms", () => {
    const onConfirmLeftOut = vi.fn();
    render(<ReportPhase reportData={leftOut} onConfirmLeftOut={onConfirmLeftOut} />);
    expect(screen.getByText("Jarabe 120 ml")).toBeTruthy();
    expect(screen.getByText("Sin costo aprobado")).toBeTruthy();
    expect(screen.queryByText("Migración terminada")).toBeNull();
    fireEvent.click(screen.getByText("Bloquear la sucursal sin estos productos"));
    expect(onConfirmLeftOut).toHaveBeenCalledTimes(1);
  });
});
