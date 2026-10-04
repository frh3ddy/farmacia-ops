import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProductsScreen } from "./ProductsScreen";

vi.mock("../../lib/apiFetch", () => ({
  ApiError: class extends Error {},
  apiFetch: vi.fn().mockResolvedValue({ data: [{ id: "p1", name: "Paracetamol 500 mg", searchAliases: [] }] }),
}));

describe("ProductsScreen", () => {
  // Regression: hooks declared after the loading early-return crashed the
  // page (React #310) as soon as products arrived.
  it("renders the product list after loading", async () => {
    render(<ProductsScreen />);
    expect(await screen.findByText("Products (1)")).toBeTruthy();
  });
});
