import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { useCutoverWizard } from "./useCutoverWizard";

vi.mock("../apiFetch", () => ({
  ApiError: class extends Error {},
  // /locations and the extraction-session extras — nothing these tests read.
  apiFetch: vi.fn().mockResolvedValue({ data: [], success: false }),
}));

vi.mock("./api", () => ({
  fetchAllSuppliers: vi.fn().mockResolvedValue([]),
  fetchCategories: vi.fn().mockResolvedValue([]),
  fetchInProgressSessions: vi.fn().mockResolvedValue([]),
  extractCosts: vi.fn(),
  reusePreviousApprovals: vi.fn(),
}));

// One product left in the batch, offered for reuse from an earlier session.
const reusable = {
  productId: "regular",
  productName: "Regular",
  extractedEntries: [],
  selectedCost: null,
  isAlreadyApproved: true,
  existingApprovedCost: 12,
  migrationStatus: "PENDING",
};

async function startExtraction() {
  vi.mocked(api.extractCosts).mockResolvedValue({
    cutoverId: "s1",
    extractionSessionId: "s1",
    extractionResults: [reusable],
    isComplete: false,
  } as never);
  const hook = renderHook(() => useCutoverWizard());
  act(() => hook.result.current.setSelectedLocationId("loc-1"));
  await act(() => hook.result.current.handleStartExtraction());
  expect(hook.result.current.phase).toBe("extracting");
  return hook;
}

beforeEach(() => vi.mocked(api.reusePreviousApprovals).mockReset());

describe("reuse previous approvals", () => {
  it("leaves a product pending when the server did not copy its approval", async () => {
    const { result } = await startExtraction();
    vi.mocked(api.reusePreviousApprovals).mockResolvedValue({ approvedCount: 0, products: [] });

    await act(() => result.current.handleReusePreviousApprovals());

    expect(result.current.groupedResults.extracting.map(r => r.productId)).toEqual(["regular"]);
    expect(result.current.batchComplete).toBe(false);
    expect(result.current.error).toMatch(/no se pudieron reutilizar/);
  });

  it("closes the batch-complete modal when switching to review", async () => {
    const { result } = await startExtraction();
    vi.mocked(api.reusePreviousApprovals).mockResolvedValue({ approvedCount: 1, products: ["regular"] });

    await act(() => result.current.handleReusePreviousApprovals());
    await waitFor(() => expect(result.current.batchComplete).toBe(true));

    act(() => result.current.setPhase("reviewing"));
    expect(result.current.batchComplete).toBe(false);
  });
});
