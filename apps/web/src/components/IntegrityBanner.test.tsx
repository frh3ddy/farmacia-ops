import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/apiFetch";
import { IntegrityBanner } from "./IntegrityBanner";

let role = "OWNER";
vi.mock("../lib/auth/AuthContext", () => ({
  useAuth: () => ({ user: { currentLocation: { locationId: "centro", locationName: "Centro", role } } }),
}));
vi.mock("../lib/apiFetch", () => ({ ApiError: class extends Error {}, apiFetch: vi.fn() }));

const now = new Date("2026-10-27T15:00:00Z");
const ok = { status: "ok", mismatches: [] };
const respond = (data: unknown) => vi.mocked(apiFetch).mockResolvedValue({ success: true, data });
const run = (checks: object, ranAt = "2026-10-27T09:00:00Z") => ({ ranAt, mismatchCount: 0, checks: { books: ok, sales: ok, fifo: ok, ...checks } });

describe("IntegrityBanner", () => {
  beforeEach(() => {
    role = "OWNER";
    vi.mocked(apiFetch).mockReset();
  });

  it("shows the owner what last night's check found, with details on demand", async () => {
    const lost = { kind: "lost", paymentId: "pay-123", locationId: "centro", createdAt: "2026-10-26T18:00:00Z" };
    const off = { check: "batch", recordId: "b-1", productId: "jarabe", locationId: "centro", expected: 6, actual: 5 };
    respond(run({ books: { status: "ok", mismatches: [off] }, sales: { status: "ok", mismatches: [lost] } }));
    render(<IntegrityBanner now={now} />);

    expect(await screen.findByText(/1 stock record doesn't add up · 1 Square payment has no sale/)).toBeTruthy();
    expect(screen.queryByText(/pay-123/)).toBeNull();
    fireEvent.click(screen.getByText("Show details"));
    expect(screen.getByText(/pay-123/)).toBeTruthy();
  });

  it("shows nothing after a clean run", async () => {
    respond(run({}));
    const { container } = render(<IntegrityBanner now={now} />);

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("says the check hasn't run when there is no run yet", async () => {
    respond(null);
    render(<IntegrityBanner now={now} />);

    expect(await screen.findByText(/The nightly integrity check hasn't run/)).toBeTruthy();
  });

  it("says the check hasn't run when the last run is more than 2 days old", async () => {
    respond(run({}, "2026-10-24T09:00:00Z"));
    render(<IntegrityBanner now={now} />);

    expect(await screen.findByText(/The nightly integrity check hasn't run/)).toBeTruthy();
  });

  it("says which check couldn't run", async () => {
    respond(run({ sales: { status: "failed", error: "ETIMEDOUT", mismatches: [] } }));
    render(<IntegrityBanner now={now} />);

    expect(await screen.findByText(/sales check couldn't run/)).toBeTruthy();
  });

  it("shows non-owners nothing and doesn't ask the api", () => {
    role = "MANAGER";
    const { container } = render(<IntegrityBanner now={now} />);

    expect(container.textContent).toBe("");
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
