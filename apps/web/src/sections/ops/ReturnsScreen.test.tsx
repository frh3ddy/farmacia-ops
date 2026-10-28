import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../lib/apiFetch";
import { ReturnsHistoryScreen, ReturnsScreen } from "./ReturnsScreen";

vi.mock("../../lib/apiFetch", () => ({
  ApiError: class extends Error {},
  apiFetch: vi.fn(async (path: string) => {
    if (path === "/api/sales/recent")
      return {
        data: [
          {
            id: "s-1",
            createdAt: "2026-10-27T18:00:00Z",
            totalRevenue: "110",
            location: { name: "Oriente" },
            items: [
              { id: "si-jarabe", quantity: 2, price: "45", product: { name: "Jarabe" }, returns: [{ quantity: 1 }] },
              { id: "si-gasas", quantity: 1, price: "20", product: { name: "Gasas" }, returns: [] },
            ],
          },
        ],
      };
    if (path === "/api/sales/returns")
      return {
        data: [
          {
            id: "r-1",
            returnedAt: "2026-10-27T19:00:00Z",
            reason: "Caducidad cercana",
            revenue: "45",
            returnedByName: "Ana",
            sale: { location: { name: "Oriente" } },
            items: [{ id: "ri-1", quantity: 1, saleItem: { product: { name: "Jarabe" } }, adjustment: { squareSynced: false, squareSyncError: "Square is down" } }],
          },
        ],
      };
    return { success: true, queued: true };
  }),
}));

describe("ReturnsScreen", () => {
  it("returns the chosen units of a recent sale with a reason, once", async () => {
    render(<ReturnsScreen />);
    fireEvent.click(await screen.findByText(/Oriente/));
    // One jarabe was already returned, so only one is left.
    expect(screen.getByLabelText("Jarabe (quedan 1)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Jarabe (quedan 1)"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "No le sirvió" } });
    fireEvent.click(screen.getByText("Registrar devolución"));

    expect(await screen.findByText("Devolución registrada")).toBeTruthy();
    const posts = vi.mocked(apiFetch).mock.calls.filter(([path]) => path === "/api/sales/s-1/returns");
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0][1]!.body as string);
    expect(body).toMatchObject({ items: [{ saleItemId: "si-jarabe", quantity: 1 }], reason: "No le sirvió" });
    expect(typeof body.clientRequestId).toBe("string");
    await waitFor(() => expect(screen.getByLabelText("Jarabe (quedan 0)")).toBeTruthy());
  });
});

describe("ReturnsHistoryScreen", () => {
  it("lists each return with who made it, and any Square stock it could not update", async () => {
    render(<ReturnsHistoryScreen />);
    expect(await screen.findByText(/Ana/)).toBeTruthy();
    expect(screen.getByText(/1 × Jarabe/)).toBeTruthy();
    expect(screen.getByText("Sin actualizar en Square: Square is down")).toBeTruthy();
  });
});
