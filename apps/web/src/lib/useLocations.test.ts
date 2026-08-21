import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLocations } from "./useLocations";
import { apiFetch } from "./apiFetch";
import type { Location } from "./types";

vi.mock("./apiFetch", () => ({ apiFetch: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

const location: Location = {
  id: "loc-1",
  name: "Sucursal Centro",
  address: null,
  isActive: true,
  squareId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("useLocations", () => {
  it("loads locations on mount", async () => {
    mockedApiFetch.mockResolvedValueOnce({ success: true, data: [location] });

    const { result } = renderHook(() => useLocations());

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.locations).toEqual([location]);
    expect(result.current.error).toBeNull();
  });

  it("sets an error message when the fetch fails", async () => {
    mockedApiFetch.mockRejectedValueOnce(new Error("Request failed (500)"));

    const { result } = renderHook(() => useLocations());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Request failed (500)");
    expect(result.current.locations).toEqual([]);
  });

  it("refetches on demand", async () => {
    mockedApiFetch.mockResolvedValueOnce({ success: true, data: [] });
    const { result } = renderHook(() => useLocations());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockedApiFetch.mockResolvedValueOnce({ success: true, data: [location] });
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.locations).toEqual([location]);
  });
});
