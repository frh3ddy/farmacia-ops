import { useEffect, useState } from "react";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { SessionSelectorModal } from "../components/SessionSelectorModal";
import type { useCutoverWizard } from "../../../lib/cutover/useCutoverWizard";
import type { CostBasis } from "../../../lib/cutover/types";

type ConfigurationPhaseProps = { wizard: ReturnType<typeof useCutoverWizard> };

const COST_METHODS: { value: CostBasis; label: string }[] = [
  { value: "DESCRIPTION", label: "Description extraction" },
  { value: "SQUARE_COST", label: "Square cost" },
  { value: "MANUAL_INPUT", label: "Manual input" },
  { value: "AVERAGE_COST", label: "Average cost" },
];

export function ConfigurationPhase({ wizard }: ConfigurationPhaseProps) {
  const {
    locations,
    selectedLocationId,
    setSelectedLocationId,
    cutoverDate,
    setCutoverDate,
    costBasis,
    setCostBasis,
    batchSize,
    setBatchSize,
    loading,
    error,
    setError,
    handleStartExtraction,
    showSessionSelector,
    existingSessions,
    handleResumeSession,
    handleStartNewExtraction,
    setShowSessionSelector,
  } = wizard;

  // Local buffer so the field can be briefly empty while typing, matching
  // the legacy behavior — batchSize itself is only ever a valid 10-500 int.
  const [batchSizeInput, setBatchSizeInput] = useState(String(batchSize));
  useEffect(() => setBatchSizeInput(String(batchSize)), [batchSize]);

  const handleBatchSizeBlur = () => {
    const parsed = parseInt(batchSizeInput, 10);
    if (!batchSizeInput.trim() || isNaN(parsed) || parsed < 10) {
      setBatchSize(50);
    } else if (parsed > 500) {
      setBatchSize(500);
    } else {
      setBatchSize(parsed);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h2 className="text-2xl font-bold text-(--color-ink)">Inventory Migration — Configuration</h2>

      <ErrorBanner error={error} onRetry={handleStartExtraction} onDismiss={() => setError(null)} />

      <div className="space-y-6">
        <div>
          <label className="mb-2 block text-sm font-medium text-(--color-ink-secondary)">
            Location <span className="text-(--color-destructive)">*</span>
          </label>
          <div className="space-y-2">
            {locations.map(loc => (
              <label
                key={loc.id}
                className="flex cursor-pointer items-center rounded-md border border-(--color-border-standard) p-3 hover:bg-(--color-surface)"
              >
                <input
                  type="radio"
                  name="location"
                  checked={selectedLocationId === loc.id}
                  onChange={() => setSelectedLocationId(loc.id)}
                  className="accent-(--color-accent)"
                />
                <span className="ml-3 text-sm text-(--color-ink)">{loc.name}</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-(--color-ink-secondary)">
            Cutover date <span className="text-(--color-destructive)">*</span>
          </label>
          <input
            type="date"
            value={cutoverDate}
            max={new Date().toISOString().split("T")[0]}
            onChange={e => setCutoverDate(e.target.value)}
            className="w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-(--color-ink-secondary)">
            Cost method <span className="text-(--color-destructive)">*</span>
          </label>
          <select
            value={costBasis}
            onChange={e => setCostBasis(e.target.value as CostBasis)}
            className="w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none"
          >
            {COST_METHODS.map(m => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-(--color-ink-secondary)">Batch quantity</label>
          <input
            type="number"
            min={10}
            max={500}
            value={batchSizeInput}
            onChange={e => setBatchSizeInput(e.target.value)}
            onBlur={handleBatchSizeBlur}
            className="tabular w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none"
          />
          <p className="mt-1 text-xs text-(--color-ink-tertiary)">Between 10 and 500 items per batch.</p>
        </div>

        <button
          onClick={handleStartExtraction}
          disabled={loading || !selectedLocationId}
          className="w-full rounded-sm bg-(--color-accent) py-2.5 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Starting…" : "Start extraction session"}
        </button>
      </div>

      <SessionSelectorModal
        show={showSessionSelector}
        sessions={existingSessions}
        currentBatchSize={batchSize}
        onResume={handleResumeSession}
        onStartNew={handleStartNewExtraction}
        onClose={() => setShowSessionSelector(false)}
      />
    </div>
  );
}
