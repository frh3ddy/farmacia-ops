import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../lib/apiFetch";
import { ProductsWithoutCostScreen } from "./ProductsWithoutCostScreen";

vi.mock("../../lib/apiFetch", () => ({
  ApiError: class extends Error {},
  apiFetch: vi.fn(async (path: string) => {
    if (path === "/products/without-cost") return { data: [{ id: "p1", name: "Nuevo Jarabe", sku: "750" }] };
    if (path.startsWith("/admin/inventory/cutover/stock-by-location"))
      return {
        locations: [
          { locationId: "loc-1", locationName: "Centro", quantity: 4 },
          { locationId: "loc-2", locationName: "Norte", quantity: 0 },
        ],
      };
    return { success: true };
  }),
}));

describe("ProductsWithoutCostScreen", () => {
  it("records Square's stock at the entered cost without syncing to Square", async () => {
    render(<ProductsWithoutCostScreen />);
    fireEvent.click(await screen.findByText("Nuevo Jarabe"));
    fireEvent.change(await screen.findByLabelText("Unit cost"), { target: { value: "12.5" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(screen.queryByText("Nuevo Jarabe")).toBeNull());
    const posts = vi.mocked(apiFetch).mock.calls.filter(([path]) => path === "/inventory/adjustments");
    // Only the location with stock — a zero-quantity adjustment is rejected by the API.
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1]!.body as string)).toMatchObject({
      locationId: "loc-1",
      productId: "p1",
      type: "FOUND",
      quantity: 4,
      unitCost: 12.5,
      syncToSquare: false,
    });
  });
});
