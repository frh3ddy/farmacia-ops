import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddProductScreen } from "./AddProductScreen";

vi.mock("../../lib/apiFetch", () => ({
  ApiError: class extends Error {},
  apiFetch: vi.fn().mockResolvedValue({ categories: [], laboratories: [], activeIngredients: [] }),
}));

describe("AddProductScreen", () => {
  it("sells a new product at every store unless switched off", async () => {
    render(<AddProductScreen />);
    const everyStore = (await screen.findByLabelText("Vender en todas las sucursales")) as HTMLInputElement;
    expect(everyStore.checked).toBe(true);

    fireEvent.click(everyStore);
    expect(everyStore.checked).toBe(false);
    expect(screen.getByText("Solo se venderá en esta sucursal.")).toBeTruthy();
  });
});
