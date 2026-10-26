import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  discardItem: vi.fn().mockResolvedValue({ success: true }),
}));

// One product left in the batch.
const pending = {
  productId: "regular",
  productName: "Regular",
  extractedEntries: [],
  selectedCost: null,
  migrationStatus: "PENDING",
};

async function startExtraction() {
  vi.mocked(api.extractCosts).mockResolvedValue({
    cutoverId: "s1",
    extractionSessionId: "s1",
    extractionResults: [pending],
    isComplete: false,
  } as never);
  const hook = renderHook(() => useCutoverWizard());
  act(() => hook.result.current.setSelectedLocationId("loc-1"));
  await act(() => hook.result.current.handleStartExtraction());
  expect(hook.result.current.phase).toBe("extracting");
  return hook;
}

describe("batch-complete modal", () => {
  it("closes when switching to review", async () => {
    const { result } = await startExtraction();

    await act(() => result.current.handleDiscardItem("regular"));
    await waitFor(() => expect(result.current.batchComplete).toBe(true));

    act(() => result.current.setPhase("reviewing"));
    expect(result.current.batchComplete).toBe(false);
  });
});
