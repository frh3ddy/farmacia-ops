import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BreakBulkScreen } from "./BreakBulkScreen";

vi.mock("../../lib/apiFetch", () => ({
  ApiError: class extends Error {},
  apiFetch: vi.fn(async (path: string) => {
    if (path === "/inventory/break-bulk/automatic")
      return {
        data: [
          { kind: "covered", at: "2026-11-08T18:00:00Z", productName: "Paracetamol suelto", quantity: 2, paymentId: "pay-2", why: "api no disponible" },
          { kind: "opened", at: "2026-11-08T17:00:00Z", productName: "Paracetamol caja", quantity: 1, paymentId: "pay-1" },
        ],
      };
    return { data: [] };
  }),
}));

describe("BreakBulkScreen automatic openings", () => {
  it("lists boxes a sale opened and shortfalls covered without a box, with the sale and why", async () => {
    render(<BreakBulkScreen />);

    expect(await screen.findByText("Abrió 1 caja de Paracetamol caja")).toBeTruthy();
    expect(screen.getByText("Faltaron 2 de Paracetamol suelto sin abrir caja: api no disponible")).toBeTruthy();
    expect(screen.getAllByText(/Venta pay-/).map((e) => e.textContent)).toEqual(["Venta pay-2", "Venta pay-1"]);
  });
});
