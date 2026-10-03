import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtractionItemEditor } from "./ExtractionItemEditor";
import type { CostExtractionResult } from "../../../lib/cutover/types";

const makeItem = (productId: string): CostExtractionResult =>
  ({
    productId,
    productName: "Paracetamol",
    originalDescription: "",
    extractedEntries: [
      { supplier: "OLD", amount: 10, originalLine: "OLD 10", confidence: "HIGH", editedEffectiveDate: "2026-01-01", isSelected: true },
    ],
  }) as CostExtractionResult;
const item = makeItem("p1");

type HarnessProps = {
  result?: CostExtractionResult;
  onApprove: (r: CostExtractionResult) => void | Promise<void>;
  onDiscard?: (productId: string) => void | Promise<void>;
};

function Harness({ result = item, onApprove, onDiscard = () => {} }: HarnessProps) {
  const [editedResults, setEditedResults] = useState<Record<string, CostExtractionResult>>({});
  return (
    <ExtractionItemEditor
      result={result}
      extractingItems={[result]}
      currentIndex={0}
      editedResults={editedResults}
      setEditedResults={setEditedResults}
      getSupplierSuggestions={() => []}
      cutoverDate="2026-09-01"
      onApprove={onApprove}
      onDiscard={onDiscard}
      onMarkDiscontinued={async () => {}}
      onZeroStock={async () => true}
      onSetPrice={async () => true}
      onRegenerateExtraction={async () => {}}
      setError={() => {}}
      hideProductImageForTransition={false}
      allCategories={[]}
    />
  );
}

// Lets the editor's post-item-change settle window elapse.
const settle = () => act(() => vi.advanceTimersByTime(400));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});
afterEach(() => vi.useRealTimers());

describe("ExtractionItemEditor draft entry", () => {
  it("previews a filled draft as the selected cost and commits it on Approve", () => {
    const onApprove = vi.fn();
    render(<Harness onApprove={onApprove} />);
    settle();

    fireEvent.change(screen.getByPlaceholderText("Add supplier"), { target: { value: "NEW" } });
    fireEvent.change(screen.getByPlaceholderText("Cost"), { target: { value: "12.5" } });

    expect((screen.getByLabelText("New entry will be used as the cost") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Use this entry as the cost") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("$12.50")).toBeTruthy();

    fireEvent.click(screen.getByText("Approve"));

    const approved: CostExtractionResult = onApprove.mock.calls[0][0];
    expect(approved.selectedCost).toBe(12.5);
    expect(approved.selectedSupplierName).toBe("NEW");
    expect(approved.extractedEntries.map(e => [e.supplier, e.isSelected])).toEqual([
      ["OLD", false],
      ["NEW", true],
    ]);
  });
});

describe("ExtractionItemEditor double-click guard", () => {
  it("ignores a second Approve click while the first is still running", () => {
    const onApprove = vi.fn(() => new Promise<void>(() => {}));
    render(<Harness onApprove={onApprove} />);
    settle();

    fireEvent.click(screen.getByText("Approve"));
    fireEvent.click(screen.getByText("Approve"));
    fireEvent.click(screen.getByText("Discard"));

    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("ignores clicks that land on a new item before it settles", () => {
    const onApprove = vi.fn();
    const { rerender } = render(<Harness onApprove={onApprove} />);
    settle();

    rerender(<Harness result={makeItem("p2")} onApprove={onApprove} />);
    fireEvent.click(screen.getByText("Approve"));
    expect(onApprove).not.toHaveBeenCalled();

    settle();
    fireEvent.click(screen.getByText("Approve"));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });
});
