import { useCutoverWizard } from "../../lib/cutover/useCutoverWizard";
import { ConfigurationPhase } from "./phases/ConfigurationPhase";
import { ExtractionPhase } from "./phases/ExtractionPhase";
import { MigrationPhase } from "./phases/MigrationPhase";
import { ReportPhase } from "./phases/ReportPhase";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";

/**
 * Replaces InventoryMigration/index.jsx. Renders the current phase off the
 * useCutoverWizard state machine — same four phases the legacy component
 * had (configuring / extracting+reviewing / migrating / reporting).
 * ReviewPhase.jsx from the legacy component tree is not ported: it's dead
 * code — `state === 'reviewing'` has always rendered ExtractionPhase with
 * its own inline "Start Migration" button, never the separate ReviewPhase
 * component.
 */
export function InventoryMigrationScreen() {
  const wizard = useCutoverWizard();
  const selectedLocation = wizard.locations.find(l => l.id === wizard.selectedLocationId);

  return (
    <div>
      {wizard.phase === "configuring" && <ConfigurationPhase wizard={wizard} />}
      {(wizard.phase === "extracting" || wizard.phase === "reviewing") && <ExtractionPhase wizard={wizard} />}
      {wizard.phase === "migrating" && <MigrationPhase migrationResult={wizard.migrationResult} />}
      {wizard.phase === "reporting" && wizard.reportData && <ReportPhase reportData={wizard.reportData} />}

      <ConfirmDialog
        open={wizard.confirmingMigration}
        title="Start migration"
        description={
          <>
            This locks historical costs for <strong>{selectedLocation?.name ?? "this location"}</strong> — inventory and costs dated on
            or before the cutover date can no longer be edited afterward.
            {wizard.pendingCount > 0 && (
              <p className="mt-2 text-(--color-warning)">
                {wizard.pendingCount} item{wizard.pendingCount !== 1 ? "s are" : " is"} still pending and will be excluded from the
                migration.
              </p>
            )}
          </>
        }
        confirmPhrase={selectedLocation?.name ?? "CONFIRM"}
        confirmLabel="Start migration"
        destructive
        onConfirm={wizard.confirmStartMigration}
        onCancel={wizard.cancelStartMigration}
      />
    </div>
  );
}
