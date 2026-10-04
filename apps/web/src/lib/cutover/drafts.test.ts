import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDrafts, saveDrafts } from "./extractionBatch";
import type { CostExtractionResult } from "./types";

const draft = (productId: string, selectedCost: number) => ({ productId, selectedCost }) as CostExtractionResult;

describe("cutover drafts", () => {
  // Node 25's own (path-less) localStorage global shadows jsdom's, so use a plain in-memory one.
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it("round-trips only still-pending items, per session", () => {
    saveDrafts("s1", { p1: draft("p1", 12.5), p2: draft("p2", 9) }, new Set(["p1"]));

    expect(loadDrafts("s1")).toEqual({ p1: draft("p1", 12.5) });
    expect(loadDrafts("s2")).toEqual({});
  });

  it("clears the session's entry once nothing is pending", () => {
    saveDrafts("s1", { p1: draft("p1", 12.5) }, new Set(["p1"]));
    saveDrafts("s1", { p1: draft("p1", 12.5) }, new Set());

    expect(localStorage.getItem("cutover-drafts:s1")).toBeNull();
  });

  it("treats corrupt storage as no drafts", () => {
    localStorage.setItem("cutover-drafts:s1", "{not json");
    expect(loadDrafts("s1")).toEqual({});
  });
});
