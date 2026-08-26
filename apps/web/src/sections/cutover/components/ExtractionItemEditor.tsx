import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { SupplierAutocompleteInput } from "./SupplierAutocompleteInput";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { Modal } from "../../../components/ui/Modal";
import type { CategoryOption, CostExtractionResult, ExtractedCostEntry, SupplierSuggestion } from "../../../lib/cutover/types";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Mirrors AddProductScreen's FORMS/ROUTES (Prisma PharmaceuticalForm /
// AdministrationRoute enums) — kept as a local copy rather than a shared
// import since AddProductScreen doesn't export them and this is the only
// other screen that needs the enum-to-Spanish-label mapping.
const FORM_LABELS: Record<string, string> = {
  TABLET: "Tableta", CAPSULE: "Cápsula", SUSPENSION: "Suspensión", SYRUP: "Jarabe",
  CREAM: "Crema", OINTMENT: "Ungüento", GEL: "Gel", INJECTION: "Inyección",
  DROPS: "Gotas", SPRAY: "Spray", PATCH: "Parche", SUPPOSITORY: "Supositorio",
  INHALER: "Inhalador", SOLUTION: "Solución", OTHER: "Otro",
};
const ROUTE_LABELS: Record<string, string> = {
  ORAL: "Oral", TOPICAL: "Tópica", INJECTABLE: "Inyectable", OPHTHALMIC: "Oftálmica",
  OTIC: "Ótica", NASAL: "Nasal", RECTAL: "Rectal", VAGINAL: "Vaginal",
  INHALED: "Inhalada", SUBLINGUAL: "Sublingual", OTHER: "Otra",
};

// Small inline icons — the app has no icon library/convention to match, and
// four one-off glyphs isn't reason enough to add one.
function DocumentIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 3v5h5M9 13h6M9 17h6" />
    </svg>
  );
}

// A viewfinder/scan motif, deliberately distinct from DocumentIcon — this
// one represents "what was read off the package photo," not a generic file.
function ScanIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 8V6a2 2 0 0 1 2-2h2M4 16v2a2 2 0 0 0 2 2h2M20 8V6a2 2 0 0 0-2-2h-2M20 16v2a2 2 0 0 1-2 2h-2M7 12h10"
      />
    </svg>
  );
}

function SparkleIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2Z" />
    </svg>
  );
}

function computeExtractedDate(entry: ExtractedCostEntry, cutoverDate: string): string | null {
  if (!entry.month) return null;
  const monthIndex = MONTH_NAMES.indexOf(entry.month);
  if (monthIndex === -1) return null;

  const yearMatch = entry.originalLine?.match(/\b(19|20)\d{2}\b/);
  let year = yearMatch ? parseInt(yearMatch[0]) : cutoverDate ? new Date(cutoverDate).getFullYear() : new Date().getFullYear();

  const day = entry.day ?? 1;
  const dayInMonth = (y: number) => new Date(y, monthIndex + 1, 0).getDate();
  let date = new Date(year, monthIndex, Math.min(day, dayInMonth(year)));

  const today = new Date();
  while (date > today) {
    year--;
    date = new Date(year, monthIndex, Math.min(day, dayInMonth(year)));
  }
  return date.toISOString().split("T")[0];
}

type ExtractionItemEditorProps = {
  result: CostExtractionResult | undefined;
  extractingItems: CostExtractionResult[];
  currentIndex: number;
  editedResults: Record<string, CostExtractionResult>;
  setEditedResults: React.Dispatch<React.SetStateAction<Record<string, CostExtractionResult>>>;
  getSupplierSuggestions: (input: string) => SupplierSuggestion[];
  cutoverDate: string;
  onApprove: (result: CostExtractionResult) => void;
  onDiscard: (productId: string) => void;
  onMarkDiscontinued: (productId: string) => Promise<void>;
  onRegenerateExtraction: (productId: string, description: string) => Promise<void>;
  onReparseOcrText: (productId: string, ocrText: string) => Promise<void>;
  setError: (message: string) => void;
  hideProductImageForTransition: boolean;
  allCategories: CategoryOption[];
};

export function ExtractionItemEditor({
  result,
  extractingItems,
  currentIndex,
  editedResults,
  setEditedResults,
  getSupplierSuggestions,
  cutoverDate,
  onApprove,
  onDiscard,
  onMarkDiscontinued,
  onRegenerateExtraction,
  onReparseOcrText,
  setError,
  hideProductImageForTransition,
  allCategories,
}: ExtractionItemEditorProps) {
  const [showPriceDetails, setShowPriceDetails] = useState(false);
  const [viewingImage, setViewingImage] = useState(false);
  const [sourceModalOpen, setSourceModalOpen] = useState(false);
  const [detectedModalOpen, setDetectedModalOpen] = useState(false);
  // Raw text of whichever cost field is currently focused. A controlled
  // number input snaps back to its last committed value on every re-render,
  // so an in-progress edit (e.g. deleting down to "") needs to be tracked
  // separately from the committed numeric value until blur.
  const [costDraft, setCostDraft] = useState<{ idx: number; raw: string } | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [reparsingOcr, setReparsingOcr] = useState(false);
  const [confirmingDiscontinue, setConfirmingDiscontinue] = useState(false);
  const [discontinuing, setDiscontinuing] = useState(false);
  const [newEntrySupplier, setNewEntrySupplier] = useState("");
  const [newEntrySupplierId, setNewEntrySupplierId] = useState<string | null>(null);
  const [newEntryCost, setNewEntryCost] = useState("");
  const [newEntryDate, setNewEntryDate] = useState(cutoverDate);
  const [newIngredientName, setNewIngredientName] = useState("");

  // Preload the next 10 product images so Next navigation feels instant.
  useEffect(() => {
    const upcoming = extractingItems.slice(currentIndex + 1, currentIndex + 11);
    for (const item of upcoming) {
      if (item.imageUrl) new Image().src = item.imageUrl;
    }
  }, [extractingItems, currentIndex]);

  const edited = result ? (editedResults[result.productId] ?? result) : null;
  const { displayCost, displaySupplier } = useMemo(() => {
    if (!edited) return { selectedEntry: null, displayCost: null, displaySupplier: "" };
    const entries = edited.extractedEntries ?? [];
    const last = entries.length > 0 ? entries[entries.length - 1] : null;
    const displayCost = edited.selectedCost ?? (last ? (last.editedCost ?? last.amount) : null);
    const displaySupplier = edited.selectedSupplierName || (last ? last.editedSupplierName || last.supplier : null) || "";
    return { selectedEntry: last, displayCost, displaySupplier };
  }, [edited]);

  // Category/Subcategory cascade, mirroring AddProductScreen — same
  // taxonomy (allCategories comes from /products/categories), derived from
  // edited.categoryId rather than tracked as separate local state so it
  // stays correct after a regenerate or a reused prior approval changes it
  // out from under the picker.
  const topCategories = useMemo(() => allCategories.filter(c => c.parentId === null), [allCategories]);
  const categoryTopId = useMemo(() => {
    if (!edited?.categoryId) return "";
    const cat = allCategories.find(c => c.id === edited.categoryId);
    if (!cat) return "";
    return cat.parentId ?? cat.id;
  }, [edited?.categoryId, allCategories]);
  const subcategories = useMemo(() => allCategories.filter(c => c.parentId === categoryTopId), [allCategories, categoryTopId]);
  const categorySubId = useMemo(() => {
    if (!edited?.categoryId) return "";
    const cat = allCategories.find(c => c.id === edited.categoryId);
    return cat?.parentId ? cat.id : "";
  }, [edited?.categoryId, allCategories]);
  // Same gate AddProductScreen uses to show its medication section, OR'd
  // with the classifier's raw suggestedCategoryId (not just the effective,
  // possibly-overridden categoryId) and with the name-parser having found
  // real ingredients. A product can already carry a stale/wrong categoryId
  // from an earlier classify run — that value wins over the suggestion in
  // effectiveCategoryId server-side, so gating on categoryTopId alone hides
  // this block for a genuine medicine whose suggested (not effective)
  // category is Medicamentos. Independent of parseConfidence either way, so
  // the block still shows even when nothing was detected — the reviewer
  // just gets an empty, editable form.
  const isMedicine =
    topCategories.find(c => c.id === categoryTopId)?.name === "Medicamentos" ||
    allCategories.find(c => c.id === edited?.suggestedCategoryId)?.name === "Medicamentos" ||
    (edited?.ingredients?.length ?? 0) > 0;

  // Reset the new-entry staging date whenever the current item changes, so
  // it doesn't carry a stale date from the previous product.
  useEffect(() => {
    setNewEntrySupplier("");
    setNewEntrySupplierId(null);
    setNewEntryCost("");
    setNewEntryDate(cutoverDate);
    setNewIngredientName("");
    setViewingImage(false);
    setSourceModalOpen(false);
    setDetectedModalOpen(false);
  }, [result?.productId, cutoverDate]);

  useEffect(() => {
    if (!viewingImage) return;
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && setViewingImage(false);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewingImage]);

  if (!result || !edited) {
    return <p className="py-8 text-center text-sm text-(--color-ink-tertiary)">No items need action</p>;
  }

  const hasExtraction = (edited.extractedEntries?.length ?? 0) > 0;

  const updateEntry = (idx: number, patch: Partial<ExtractedCostEntry>) => {
    setEditedResults(prev => {
      const base = prev[result.productId] ?? result;
      const entries = [...(base.extractedEntries ?? result.extractedEntries ?? [])];
      entries[idx] = { ...entries[idx], ...patch };
      const selIdx = entries.findIndex(e => e.isSelected);
      const isSelectedEntry = idx === (selIdx === -1 ? entries.length - 1 : selIdx);
      const next: CostExtractionResult = { ...base, extractedEntries: entries };
      if (isSelectedEntry) {
        if ("editedSupplierName" in patch) next.selectedSupplierName = patch.editedSupplierName ?? null;
        if ("supplierId" in patch) next.selectedSupplierId = patch.supplierId ?? null;
        if ("editedCost" in patch) next.selectedCost = patch.editedCost ?? null;
      }
      return { ...prev, [result.productId]: next };
    });
  };

  // User picks which extracted entry is "the" cost — mirrors what the
  // approve flow already reads (extractedEntries.find(isSelected) ?? last).
  const selectEntry = (idx: number) => {
    setEditedResults(prev => {
      const base = prev[result.productId] ?? result;
      const entries = (base.extractedEntries ?? result.extractedEntries ?? []).map((e, i) => ({ ...e, isSelected: i === idx }));
      const sel = entries[idx];
      return {
        ...prev,
        [result.productId]: {
          ...base,
          extractedEntries: entries,
          selectedSupplierName: sel.editedSupplierName ?? sel.supplier ?? null,
          selectedSupplierId: sel.supplierId ?? null,
          selectedCost: sel.editedCost ?? sel.amount ?? null,
        },
      };
    });
  };

  const updateManualField = (patch: Partial<CostExtractionResult>) => {
    setEditedResults(prev => ({ ...prev, [result.productId]: { ...(prev[result.productId] ?? result), ...patch } }));
  };

  const updateIngredient = (idx: number, patch: Partial<NonNullable<CostExtractionResult["ingredients"]>[number]>) => {
    const next = [...(edited.ingredients ?? [])];
    next[idx] = { ...next[idx], ...patch };
    updateManualField({ ingredients: next });
  };

  const removeIngredient = (idx: number) => {
    updateManualField({ ingredients: (edited.ingredients ?? []).filter((_, i) => i !== idx) });
  };

  const addIngredient = () => {
    const name = newIngredientName.trim();
    if (!name) return;
    updateManualField({
      ingredients: [...(edited.ingredients ?? []), { name, concentrationValue: null, concentrationUnit: null }],
    });
    setNewIngredientName("");
  };

  const handleCostChange = (idx: number, rawValue: string) => {
    setCostDraft({ idx, raw: rawValue });
    if (rawValue === "") return;
    const newCost = parseFloat(rawValue) || 0;
    updateEntry(idx, { editedCost: newCost });
  };

  const handleCostBlur = (idx: number, e: React.FocusEvent<HTMLInputElement>) => {
    const newCost = parseFloat(e.target.value) || 0;
    if (newCost < 0) return setError("Cost cannot be negative");
    if (newCost === 0 && !window.confirm("Cost is zero. Are you sure?")) {
      e.target.focus();
      return; // keep the draft so the refocused field still shows what they typed
    }
    updateEntry(idx, { editedCost: newCost });
    setCostDraft(null);
  };

  // Always appends to the end of extractedEntries — never inserts. The
  // approve flow's initials-learning diff (collectInitialsToLearn) zips
  // original/edited entries by array index, so a tail-appended entry safely
  // falls outside the original array's bounds; inserting anywhere else
  // would desync that diff.
  const addManualEntry = () => {
    const amount = parseFloat(newEntryCost) || 0;
    if (!newEntrySupplier.trim() || amount <= 0) return setError("Enter a supplier and a cost greater than 0");
    setEditedResults(prev => {
      const base = prev[result.productId] ?? result;
      const entries = (base.extractedEntries ?? []).map(e => ({ ...e, isSelected: false }));
      entries.push({
        supplier: newEntrySupplier,
        amount,
        originalLine: "Manually added",
        confidence: "LOW",
        supplierId: newEntrySupplierId,
        editedSupplierName: newEntrySupplier,
        editedCost: amount,
        editedEffectiveDate: newEntryDate,
        isSelected: true,
      });
      return {
        ...prev,
        [result.productId]: {
          ...base,
          extractedEntries: entries,
          selectedSupplierName: newEntrySupplier,
          selectedSupplierId: newEntrySupplierId,
          selectedCost: amount,
        },
      };
    });
    setNewEntrySupplier("");
    setNewEntrySupplierId(null);
    setNewEntryCost("");
    setNewEntryDate(cutoverDate);
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      await onRegenerateExtraction(result.productId, edited.originalDescription ?? "");
    } finally {
      setRegenerating(false);
    }
  };

  const handleReparseOcr = async () => {
    setReparsingOcr(true);
    try {
      await onReparseOcrText(result.productId, edited.ocrText ?? "");
    } finally {
      setReparsingOcr(false);
    }
  };

  const handleConfirmDiscontinue = async () => {
    setDiscontinuing(true);
    try {
      await onMarkDiscontinued(result.productId);
    } finally {
      setDiscontinuing(false);
      setConfirmingDiscontinue(false);
    }
  };

  const priceGuardWarning = (() => {
    const minCents = result.sellingPrice?.priceCents;
    if (minCents == null || displayCost == null) return result.priceGuard?.isCostTooHigh ? result.priceGuard.message : null;
    const costCents = Math.round(displayCost * 100);
    return costCents >= minCents ? `Cost ($${displayCost.toFixed(2)}) is ≥ min selling price ($${(minCents / 100).toFixed(2)})` : null;
  })();

  // Compresses the old always-visible sentence ("Detected from name —
  // confirm or edit" / "no se detectó automáticamente...") into a glanceable
  // pill next to the Detected Info header.
  const confidencePill =
    edited.parseConfidence && (edited.ingredients?.length ?? 0) > 0
      ? edited.parseConfidence === "LOW"
        ? { label: "Guessed — please verify", tone: "warning" as const }
        : { label: "Detected from name", tone: "accent" as const }
      : { label: "Not detected", tone: "muted" as const };
  const pillClasses = {
    accent: "bg-(--color-accent)/10 text-(--color-accent)",
    warning: "bg-(--color-warning-bg) text-(--color-warning)",
    muted: "bg-(--color-surface-inset) text-(--color-ink-tertiary)",
  }[confidencePill.tone];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-(--color-border-standard) bg-(--color-surface-raised)">
        <div className="border-b border-(--color-border-standard) px-6 py-3">
          <h3 className="text-lg font-semibold text-(--color-ink)">{result.productName}</h3>
        </div>

        <div className="space-y-4 p-6">
          {/* Left: image + intelligence card, then supplier history below.
              Right: detected info, spanning the full height of both —
              matches the reference mockup's 2-column relationship rather
              than a 3-across row. */}
          <div className="grid grid-cols-3 items-start gap-4">
            <div className="order-2 col-span-2 space-y-4">
              <div className="grid grid-cols-[10rem_1fr] gap-4">
                <div className="flex flex-col items-center justify-center rounded-md border border-(--color-border-standard) bg-(--color-surface-inset) p-3">
              {result.imageUrl && !hideProductImageForTransition ? (
                <button
                  type="button"
                  onClick={() => setViewingImage(true)}
                  className="h-28 w-28 cursor-zoom-in rounded-sm focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
                  aria-label="View full-size image"
                >
                  <img src={result.imageUrl} alt={result.productName} className="h-full w-full object-contain" />
                </button>
              ) : (
                <span className="px-2 text-center text-xs text-(--color-ink-muted)">
                  {hideProductImageForTransition ? "Loading…" : "No image"}
                </span>
              )}
            </div>

            {viewingImage &&
              result.imageUrl &&
              createPortal(
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
                  onClick={() => setViewingImage(false)}
                >
                  <img
                    src={result.imageUrl}
                    alt={result.productName}
                    onClick={e => e.stopPropagation()}
                    className="max-h-full max-w-full rounded-lg object-contain"
                  />
                  <button
                    type="button"
                    onClick={() => setViewingImage(false)}
                    aria-label="Close"
                    className="absolute right-4 top-4 rounded-full bg-black/50 px-3 py-1.5 text-sm font-medium text-white hover:bg-black/70"
                  >
                    Close
                  </button>
                </div>,
                document.body
              )}

            <div className="rounded-md border border-(--color-border-standard) bg-(--color-surface) p-4">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-(--color-ink-tertiary)">Selling price</p>
                  {result.sellingPrice ? (
                    <p className="tabular text-xl font-semibold text-(--color-ink)">
                      {result.sellingPriceRange && result.sellingPriceRange.minCents !== result.sellingPriceRange.maxCents
                        ? `$${(result.sellingPrice.priceCents / 100).toFixed(2)}–$${(result.sellingPriceRange.maxCents / 100).toFixed(2)}`
                        : `$${(result.sellingPrice.priceCents / 100).toFixed(2)}`}
                    </p>
                  ) : (
                    <p className="text-sm text-(--color-ink-muted)">Not set</p>
                  )}
                  {result.sellingPrices && result.sellingPrices.length > 1 && (
                    <button
                      onClick={() => setShowPriceDetails(v => !v)}
                      className="mt-0.5 text-xs font-medium text-(--color-accent) hover:text-(--color-accent-hover)"
                    >
                      {showPriceDetails ? "Hide" : "Show"} variations
                    </button>
                  )}
                </div>
                {/* The two fields this approval actually writes — accent-colored
                    labels (and, for cost, the value too) so they read as the
                    operative numbers at a glance, not just more page text next
                    to the informational selling price. */}
                <div>
                  <p className="text-xs font-medium text-(--color-accent)">Base cost</p>
                  <p className="tabular text-xl font-bold text-(--color-accent)">
                    ${displayCost != null ? displayCost.toFixed(2) : "0.00"}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-(--color-accent)">Current supplier</p>
                  <p className="truncate text-xl font-bold text-(--color-ink)">{displaySupplier || "Not selected"}</p>
                </div>
              </div>

              {priceGuardWarning && (
                <div className="mt-3 rounded-sm border border-(--color-destructive) bg-(--color-destructive-bg) px-3 py-2 text-xs text-(--color-destructive)">
                  {priceGuardWarning}
                </div>
              )}

              <div className="mt-4 grid grid-cols-2 gap-4 border-t border-(--color-border-subtle) pt-4">
                <div>
                  <label className="mb-0.5 block text-xs text-(--color-ink-tertiary)">Category</label>
                  <select
                    value={categoryTopId}
                    onChange={e => {
                      const topId = e.target.value;
                      updateManualField({
                        categoryId: topId || null,
                        categoryName: allCategories.find(c => c.id === topId)?.name ?? null,
                      });
                    }}
                    className="w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-2 py-1 text-xs text-(--color-ink) focus:border-(--color-accent) focus:outline-none"
                  >
                    <option value="">Uncategorized</option>
                    {topCategories.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-0.5 block text-xs text-(--color-ink-tertiary)">Subcategory</label>
                  <select
                    value={categorySubId}
                    onChange={e => {
                      const targetId = e.target.value || categoryTopId;
                      updateManualField({
                        categoryId: targetId || null,
                        categoryName: allCategories.find(c => c.id === targetId)?.name ?? null,
                      });
                    }}
                    disabled={!categoryTopId || subcategories.length === 0}
                    className="w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-2 py-1 text-xs text-(--color-ink) focus:border-(--color-accent) focus:outline-none disabled:opacity-50"
                  >
                    <option value="">{categoryTopId ? "None" : "—"}</option>
                    {subcategories.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {showPriceDetails && result.sellingPrices && result.sellingPrices.length > 1 && (
                <div className="mt-3 space-y-1 border-t border-(--color-border-subtle) pt-3">
                  {result.sellingPrices.map((price, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between rounded-sm border border-(--color-border-subtle) bg-(--color-surface-inset) px-2 py-1 text-sm"
                    >
                      <span className="font-medium">{price.variationName || `Variation ${idx + 1}`}</span>
                      <span className="tabular">${(price.priceCents / 100).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {!hasExtraction && (
            <p className="text-sm font-medium text-(--color-destructive)">No cost extracted — add one manually below</p>
          )}

          <div className="overflow-hidden rounded-md border border-(--color-border-standard)">
            <div className="flex items-center justify-between bg-(--color-surface) px-4 py-2.5">
              <h4 className="text-sm font-semibold text-(--color-ink)">Supplier history &amp; costs</h4>
              <button
                type="button"
                onClick={() => setSourceModalOpen(true)}
                className="flex items-center gap-1 text-xs font-medium text-(--color-accent) hover:text-(--color-accent-hover)"
              >
                <DocumentIcon className="h-3.5 w-3.5" />
                Source info
              </button>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-t border-(--color-border-standard) bg-(--color-surface) text-xs uppercase text-(--color-ink-tertiary)">
                  <th className="px-2 py-2 text-center">Use</th>
                  <th className="px-4 py-2 text-left">Supplier</th>
                  <th className="px-4 py-2 text-left">Cost</th>
                  <th className="px-4 py-2 text-left">Date</th>
                  <th className="px-4 py-2 text-left">Source</th>
                </tr>
              </thead>
              <tbody>
                {(edited.extractedEntries ?? []).map((entry, idx) => {
                  const entries = edited.extractedEntries ?? [];
                  const selIdx = entries.findIndex(e => e.isSelected);
                  const isSelectedRow = idx === (selIdx === -1 ? entries.length - 1 : selIdx);
                  const displayDate =
                    entry.editedEffectiveDate ||
                    computeExtractedDate(entry, cutoverDate) ||
                    cutoverDate ||
                    new Date().toISOString().split("T")[0];
                  return (
                    <tr key={idx} className={isSelectedRow ? "bg-(--color-accent)/5" : "border-t border-(--color-border-subtle)"}>
                      <td className="p-0 text-center">
                        <label className="flex h-full w-full cursor-pointer items-center justify-center px-2 py-4">
                          <input
                            type="radio"
                            name={`selected-entry-${result.productId}`}
                            checked={isSelectedRow}
                            onChange={() => selectEntry(idx)}
                            aria-label="Use this entry as the cost"
                            className="h-4 w-4 accent-(--color-accent)"
                          />
                        </label>
                      </td>
                      <td className="px-4 py-2">
                        <SupplierAutocompleteInput
                          value={entry.editedSupplierName ?? entry.supplier ?? ""}
                          onChange={v => updateEntry(idx, { editedSupplierName: v })}
                          onSelectSuggestion={s => updateEntry(idx, { editedSupplierName: s.name, supplierId: s.id ?? undefined })}
                          getLocalSuggestions={getSupplierSuggestions}
                          highlighted={isSelectedRow}
                          matchedByInitialLabel={entry.matchedByInitial ? entry.supplier : null}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={costDraft?.idx === idx ? costDraft.raw : (entry.editedCost ?? entry.amount)}
                          onChange={e => handleCostChange(idx, e.target.value)}
                          onBlur={e => handleCostBlur(idx, e)}
                          className={`w-full rounded-sm border px-2 py-1 text-sm tabular focus:outline-none focus:ring-2 focus:ring-(--color-accent) ${
                            isSelectedRow ? "border-(--color-accent) bg-(--color-accent)/5" : "border-(--color-border-standard)"
                          }`}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="date"
                          value={displayDate}
                          onChange={e => updateEntry(idx, { editedEffectiveDate: e.target.value })}
                          className={`w-full rounded-sm border px-2 py-1 text-sm tabular focus:outline-none focus:ring-2 focus:ring-(--color-accent) ${
                            isSelectedRow ? "border-(--color-accent) bg-(--color-accent)/5" : "border-(--color-border-standard)"
                          }`}
                        />
                      </td>
                      <td className="px-4 py-2 text-(--color-ink-tertiary)">{entry.originalLine || `$${entry.amount.toFixed(2)}`}</td>
                    </tr>
                  );
                })}
                <tr className="border-t border-(--color-border-subtle)">
                  <td className="px-2 py-2" />
                  <td className="px-4 py-2">
                    <SupplierAutocompleteInput
                      value={newEntrySupplier}
                      onChange={setNewEntrySupplier}
                      onSelectSuggestion={s => {
                        setNewEntrySupplier(s.name);
                        setNewEntrySupplierId(s.id ?? null);
                      }}
                      getLocalSuggestions={getSupplierSuggestions}
                      placeholder="Add supplier"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={newEntryCost}
                      onChange={e => setNewEntryCost(e.target.value)}
                      placeholder="Cost"
                      className="w-full rounded-sm border border-(--color-border-standard) px-2 py-1 text-sm tabular focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="date"
                      value={newEntryDate}
                      onChange={e => setNewEntryDate(e.target.value)}
                      className="w-full rounded-sm border border-(--color-border-standard) px-2 py-1 text-sm tabular focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={addManualEntry}
                      className="rounded-sm border border-(--color-border-standard) px-3 py-1 text-sm font-medium text-(--color-ink-secondary) hover:bg-(--color-surface)"
                    >
                      + Add entry
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
            </div>

            {isMedicine && !edited.isCatalogedMedication && (
              <div className="order-1 space-y-3 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <SparkleIcon className="h-3.5 w-3.5 text-(--color-accent)" />
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-(--color-ink-tertiary)">Detected info</h4>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDetectedModalOpen(true)}
                    aria-label="View or edit the text read from the package photo"
                    className="text-(--color-ink-tertiary) hover:text-(--color-accent)"
                  >
                    <ScanIcon className="h-4 w-4" />
                  </button>
                </div>
                <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${pillClasses}`}>{confidencePill.label}</span>

                <div>
                  <label className="mb-1 block text-xs text-(--color-ink-tertiary)">Principio(s) activo(s)</label>
                  <div className="space-y-1.5">
                    {(edited.ingredients ?? []).map((ing, idx) => (
                      <div key={idx} className="flex gap-1.5">
                        <input
                          value={ing.name}
                          onChange={e => updateIngredient(idx, { name: e.target.value })}
                          placeholder="Paracetamol"
                          className="flex-[2] min-w-0 rounded-sm border border-(--color-border-standard) px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
                        />
                        <input
                          value={ing.concentrationValue ?? ""}
                          onChange={e => updateIngredient(idx, { concentrationValue: e.target.value ? parseFloat(e.target.value) : null })}
                          type="number"
                          placeholder="500"
                          className="w-16 shrink-0 rounded-sm border border-(--color-border-standard) px-2 py-1 text-sm tabular focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
                        />
                        {/* Not always a bare unit — "mg/5 ml"/"mg/100 mL"-style
                            per-volume concentrations are a normal shape here
                            too (see splitCompoundConcentration), so this needs
                            more than a few characters of room. */}
                        <input
                          value={ing.concentrationUnit ?? ""}
                          onChange={e => updateIngredient(idx, { concentrationUnit: e.target.value || null })}
                          placeholder="mg o mg/5 ml"
                          className="flex-1 min-w-0 rounded-sm border border-(--color-border-standard) px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
                        />
                        <button
                          type="button"
                          onClick={() => removeIngredient(idx)}
                          aria-label={`Quitar ${ing.name}`}
                          className="shrink-0 px-1 text-(--color-ink-tertiary) hover:text-(--color-destructive)"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <div className="flex gap-1.5">
                      <input
                        value={newIngredientName}
                        onChange={e => setNewIngredientName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addIngredient();
                          }
                        }}
                        placeholder="+ agregar principio activo"
                        className="flex-1 rounded-sm border border-(--color-border-standard) px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
                      />
                      <button
                        type="button"
                        onClick={addIngredient}
                        className="shrink-0 rounded-sm border border-(--color-border-standard) px-2 py-1 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface)"
                      >
                        Agregar
                      </button>
                    </div>
                  </div>
                  {edited.concentrationOptions && edited.concentrationOptions.length > 0 && (
                    <p className="mt-1 text-xs text-(--color-ink-tertiary)">Concentraciones conocidas: {edited.concentrationOptions.join(", ")}</p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs text-(--color-ink-tertiary)">Forma</label>
                    <select
                      value={edited.form ?? ""}
                      onChange={e => updateManualField({ form: e.target.value || null })}
                      className="w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-2 py-1 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none"
                    >
                      <option value="">Sin especificar</option>
                      {Object.entries(FORM_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-(--color-ink-tertiary)">Vía</label>
                    <select
                      value={edited.route ?? ""}
                      onChange={e => updateManualField({ route: e.target.value || null })}
                      className="w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-2 py-1 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none"
                    >
                      <option value="">Sin especificar</option>
                      {(edited.routeOptions && edited.routeOptions.length > 0 ? edited.routeOptions : Object.keys(ROUTE_LABELS)).map(value => (
                        <option key={value} value={value}>
                          {ROUTE_LABELS[value] ?? value}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs text-(--color-ink-tertiary)">Presentación</label>
                  <input
                    value={edited.presentation ?? ""}
                    onChange={e => updateManualField({ presentation: e.target.value || null })}
                    placeholder="Caja c/20 tabletas"
                    className="w-full rounded-sm border border-(--color-border-standard) px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs text-(--color-ink-tertiary)">Marcas conocidas</label>
                  <input
                    value={(edited.brandSearchTerms ?? []).join(", ")}
                    onChange={e => updateManualField({ brandSearchTerms: e.target.value.split(",").map(t => t.trim()).filter(Boolean) })}
                    placeholder="Tylenol, Panadol"
                    className="w-full rounded-sm border border-(--color-border-standard) px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Pinned to the bottom of main's own scroll area (App.tsx's <main>
            is h-screen + overflow-y-auto, same bounded pattern Sidebar
            already uses) — sticky, not fixed, so it stays in normal flow
            horizontally (no need to duplicate Sidebar's width or
            ExtractionPhase's max-w-6xl/px-8 to line up) and still respects
            the card's own bottom edge once you've scrolled past it, rather
            than floating past it. */}
        <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 rounded-b-lg border-t border-(--color-border-standard) bg-(--color-surface-raised) px-6 py-4">
          <button
            onClick={() => setConfirmingDiscontinue(true)}
            className="text-xs font-medium text-(--color-destructive) hover:underline"
          >
            Mark as no longer for sale
          </button>
          <div className="flex gap-3">
            <button
              onClick={() => onDiscard(result.productId)}
              className="rounded-sm border border-(--color-destructive) px-4 py-2 text-sm font-medium text-(--color-destructive) hover:bg-(--color-destructive-bg)"
            >
              Discard
            </button>
            <button
              onClick={() => onApprove(edited)}
              className="rounded-sm bg-(--color-success) px-4 py-2 text-sm font-medium text-(--color-accent-contrast)"
            >
              Approve
            </button>
          </div>
        </div>
      </div>

      <Modal open={sourceModalOpen} onClose={() => setSourceModalOpen(false)} title="Source info">
        <label className="block text-xs text-(--color-ink-tertiary)">Source description</label>
        <textarea
          value={edited.originalDescription ?? ""}
          onChange={e => updateManualField({ originalDescription: e.target.value })}
          rows={4}
          placeholder="No description on file"
          className="mt-0.5 w-full rounded-sm border border-(--color-border-standard) px-2 py-1.5 text-sm text-(--color-ink-secondary) focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
        />
        <button
          onClick={handleRegenerate}
          disabled={regenerating}
          className="mt-2 text-sm font-medium text-(--color-accent) hover:text-(--color-accent-hover) disabled:opacity-50"
        >
          {regenerating ? "Regenerating…" : "Regenerate from description"}
        </button>
      </Modal>

      <Modal open={detectedModalOpen} onClose={() => setDetectedModalOpen(false)} title="Text read from package photo">
        <textarea
          value={edited.ocrText ?? ""}
          onChange={e => updateManualField({ ocrText: e.target.value })}
          rows={10}
          spellCheck={false}
          placeholder="No text recognized from the package photo yet"
          className="w-full resize-y rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-2 py-1.5 font-mono text-xs leading-relaxed text-(--color-ink-secondary) focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-(--color-ink-tertiary)">
            Feeds the category and ingredient suggestions. Fix misreads here, then try again — corrections are saved when you
            approve.
          </p>
          <button
            type="button"
            onClick={handleReparseOcr}
            disabled={reparsingOcr || !(edited.ocrText ?? "").trim()}
            className="shrink-0 text-xs font-medium text-(--color-accent) hover:text-(--color-accent-hover) disabled:opacity-50"
          >
            {reparsingOcr ? "Trying…" : "Try again"}
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmingDiscontinue}
        title="Mark as no longer for sale?"
        description={`"${result.productName}" will be permanently removed from Square's catalog once migration runs, and excluded from inventory in this and all future cutover sessions.`}
        mathChallenge
        confirmLabel={discontinuing ? "Marking…" : "Mark discontinued"}
        destructive
        onConfirm={handleConfirmDiscontinue}
        onCancel={() => setConfirmingDiscontinue(false)}
      />
    </div>
  );
}
