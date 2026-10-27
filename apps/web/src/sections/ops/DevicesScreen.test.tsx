import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../lib/apiFetch";
import { DevicesScreen } from "./DevicesScreen";

vi.mock("../../lib/auth/AuthContext", () => ({
  useAuth: () => ({
    user: {
      currentLocation: { locationId: "centro", locationName: "Centro", role: "OWNER" },
      accessibleLocations: [{ locationId: "centro", locationName: "Centro", role: "OWNER" }],
    },
  }),
}));

vi.mock("../../lib/apiFetch", () => ({
  ApiError: class extends Error {},
  apiFetch: vi.fn(async (path: string) => {
    if (path.startsWith("/auth/devices"))
      return {
        data: [
          { id: "caja", name: "Caja 1", type: "FIXED", isActive: true, lastActiveAt: null, activatedAt: "2026-10-01", pinLocked: true },
          { id: "oficina", name: "Oficina", type: "WEB", isActive: true, lastActiveAt: null, activatedAt: "2026-10-01", pinLocked: false },
        ],
      };
    return { success: true };
  }),
}));

describe("DevicesScreen", () => {
  it("lets the owner unlock a device locked out by wrong PINs", async () => {
    render(<DevicesScreen />);

    // Only the locked device offers an unlock.
    fireEvent.click(await screen.findByText("Unlock"));
    expect(screen.getAllByText("Unlock")).toHaveLength(1);

    await waitFor(() => expect(screen.queryByText("Locked")).toBeNull());
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith("/auth/device/caja/unlock", { method: "POST" });
  });
});
