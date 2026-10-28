import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../lib/apiFetch";
import { UnmatchedLinesScreen } from "./UnmatchedLinesScreen";

vi.mock("../../lib/apiFetch", () => ({
  ApiError: class extends Error {},
  apiFetch: vi.fn(async (path: string) => {
    if (path === "/api/sales/unmatched-lines")
      return {
        data: [
          { id: "l-1", description: "crema roja", quantity: 2, amount: "30", sale: { createdAt: "2026-10-27T18:00:00Z", location: { id: "loc-1", name: "Oriente" } } },
          { id: "l-2", description: null, quantity: 1, amount: "16", sale: { createdAt: "2026-10-21T01:55:00Z", location: { id: "loc-1", name: "Oriente" } } },
        ],
      };
    if (path.startsWith("/products?search=")) return { data: [{ id: "p-crema", name: "Crema Roja 30 g", sku: null, quantity: 5, looseProductId: null }] };
    return { success: true, queued: true };
  }),
}));

describe("UnmatchedLinesScreen", () => {
  it("matches a custom amount to the chosen product and drops it from the list", async () => {
    render(<UnmatchedLinesScreen />);
    expect(await screen.findByText("Sin descripción")).toBeTruthy();

    fireEvent.click(screen.getByText("crema roja"));
    fireEvent.change(screen.getByPlaceholderText("Buscar por nombre o SKU…"), { target: { value: "crema" } });
    fireEvent.click(await screen.findByText("Crema Roja 30 g", {}, { timeout: 2000 }));
    fireEvent.click(screen.getByText("Asignar"));

    await waitFor(() => expect(screen.queryByText("crema roja")).toBeNull());
    const posts = vi.mocked(apiFetch).mock.calls.filter(([path]) => path === "/api/sales/unmatched-lines/l-1/match");
    expect(posts.map(([, init]) => JSON.parse(init!.body as string))).toEqual([{ productId: "p-crema" }]);
    expect(screen.getByText("Sin descripción")).toBeTruthy();
  });
});
