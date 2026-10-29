import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../lib/apiFetch";
import { TransfersScreen } from "./TransfersScreen";

let role = "OWNER";
vi.mock("../../lib/auth/AuthContext", () => ({
  useAuth: () => ({ user: { currentLocation: { locationId: "centro", locationName: "Centro", role } } }),
}));
vi.mock("../../lib/apiFetch", () => ({ ApiError: class extends Error {}, apiFetch: vi.fn() }));

const received = (sync: object) => ({
  id: "t-1",
  status: "RECEIVED",
  quantity: 6,
  createdAt: "2026-10-28T15:00:00Z",
  shippedAt: "2026-10-28T15:00:00Z",
  receivedAt: "2026-10-29T15:00:00Z",
  product: { id: "p-1", name: "Jarabe", sku: null },
  fromLocation: { id: "centro", name: "Centro" },
  toLocation: { id: "norte", name: "Norte" },
  lines: [],
  ...sync,
});

const listing = (transfer: object) =>
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === "/transfers") return { success: true, data: [transfer] };
    if (path.endsWith("/retry-square-sync")) return { success: true, data: { synced: true } };
    return { success: true, data: [] }; // locations for the create card
  });

describe("TransfersScreen", () => {
  beforeEach(() => {
    role = "OWNER";
    vi.mocked(apiFetch).mockReset();
  });

  it("lets the owner resend a received transfer Square rejected", async () => {
    listing(received({ squareSynced: false, squareSyncError: "Square is down" }));
    render(<TransfersScreen />);

    expect(await screen.findByText("Sin actualizar en Square: Square is down")).toBeTruthy();
    fireEvent.click(screen.getByText("Reintentar"));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith("/transfers/t-1/retry-square-sync", { method: "POST" }),
    );
    // The list reloads to show the new result.
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([p]) => p === "/transfers")).toHaveLength(2));
  });

  it("shows a manager the failure without the retry", async () => {
    role = "MANAGER";
    listing(received({ squareSynced: false, squareSyncError: "Square is down" }));
    render(<TransfersScreen />);

    expect(await screen.findByText("Sin actualizar en Square: Square is down")).toBeTruthy();
    expect(screen.queryByText("Reintentar")).toBeNull();
  });

  it("says nothing about Square for a synced transfer", async () => {
    listing(received({ squareSynced: true, squareSyncError: null }));
    render(<TransfersScreen />);

    expect(await screen.findByText("Jarabe")).toBeTruthy();
    expect(screen.queryByText(/Sin actualizar en Square/)).toBeNull();
  });
});
