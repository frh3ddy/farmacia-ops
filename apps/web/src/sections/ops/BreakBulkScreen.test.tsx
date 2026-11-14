import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../lib/apiFetch";
import { BreakBulkScreen } from "./BreakBulkScreen";

vi.mock("../../lib/auth/AuthContext", () => ({
  useAuth: () => ({
    user: {
      currentLocation: { locationId: "oriente", locationName: "Oriente", role: "OWNER" },
      accessibleLocations: [
        { locationId: "oriente", locationName: "Oriente", role: "OWNER" },
        { locationId: "centro", locationName: "Centro", role: "OWNER" },
      ],
    },
  }),
}));

vi.mock("../../lib/apiFetch", () => ({
  ApiError: class extends Error {},
  apiFetch: vi.fn(async (path: string) => {
    if (path === "/inventory/break-bulk/automatic?locationId=oriente")
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

describe("BreakBulkScreen link card", () => {
  it("says the link is for the store being worked at", async () => {
    render(<BreakBulkScreen />);

    expect(await screen.findByText("Se vincula solo en Oriente; cada sucursal elige su propio suelto.")).toBeTruthy();
  });
});

describe("BreakBulkScreen store picker", () => {
  it("works at the store picked, starting at the session's", async () => {
    render(<BreakBulkScreen />);
    const picker = (await screen.findByLabelText("Sucursal")) as HTMLSelectElement;
    expect(picker.value).toBe("oriente");

    fireEvent.change(picker, { target: { value: "centro" } });
    fireEvent.change(screen.getAllByPlaceholderText("Paracetamol 500mg Caja…")[0], { target: { value: "para" } });

    expect(await screen.findByText("Se vincula solo en Centro; cada sucursal elige su propio suelto.")).toBeTruthy();
    await waitFor(() => {
      const paths = vi.mocked(apiFetch).mock.calls.map(([path]) => path);
      expect(paths).toContain("/inventory/break-bulk/automatic?locationId=centro");
      expect(paths).toContain("/products?search=para&limit=8&locationId=centro");
    }, { timeout: 2000 });
  });
});
