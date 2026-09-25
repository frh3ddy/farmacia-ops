import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExtractionItemEditor } from "./ExtractionItemEditor";
import type { CostExtractionResult } from "../../../lib/cutover/types";

const item: CostExtractionResult = {
  productId: "p1",
  productName: "Paracetamol",
  originalDescription: "",
  extractedEntries: [
    { supplier: "OLD", amount: 10, originalLine: "OLD 10", confidence: "HIGH", editedEffectiveDate: "2026-01-01", isSelected: true },
  ],
} as CostExtractionResult;

function Harness({ onApprove }: { onApprove: (r: CostExtractionResult) => void }) {
  const [editedResults, setEditedResults] = useState<Record<string, CostExtractionResult>>({});
  return (
    <ExtractionItemEditor
      result={item}
      extractingItems={[item]}
      currentIndex={0}
      editedResults={editedResults}
      setEditedResults={setEditedResults}
      getSupplierSuggestions={() => []}
      cutoverDate="2026-09-01"
      onApprove={onApprove}
      onDiscard={() => {}}
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

describe("ExtractionItemEditor draft entry", () => {
  it("previews a filled draft as the selected cost and commits it on Approve", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const onApprove = vi.fn();
    render(<Harness onApprove={onApprove} />);

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
