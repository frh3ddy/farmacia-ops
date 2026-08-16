import { useState, type ComponentType } from "react";
import { Sidebar } from "./components/Sidebar";
import { UserHeader } from "./components/UserHeader";
import { NAV_SECTIONS } from "./lib/navigation";
import { LocationsScreen } from "./sections/ops/LocationsScreen";
import { ProductsScreen } from "./sections/ops/ProductsScreen";
import { SuppliersScreen } from "./sections/ops/SuppliersScreen";
import { CatalogMappingsScreen } from "./sections/ops/CatalogMappingsScreen";
import { CatalogSyncScreen } from "./sections/ops/CatalogSyncScreen";
import { DevicesScreen } from "./sections/ops/DevicesScreen";
import { WebhookTestScreen } from "./sections/dev-tools/WebhookTestScreen";
import { SalesTestScreen } from "./sections/dev-tools/SalesTestScreen";
import { TestInventoryScreen } from "./sections/dev-tools/TestInventoryScreen";
import { InventoryAgingScreen } from "./sections/reports/InventoryAgingScreen";
import { InventoryMigrationScreen } from "./sections/cutover/InventoryMigrationScreen";

const SCREENS: Record<string, ComponentType> = {
  locations: LocationsScreen,
  products: ProductsScreen,
  suppliers: SuppliersScreen,
  "catalog-mappings": CatalogMappingsScreen,
  "catalog-sync": CatalogSyncScreen,
  devices: DevicesScreen,
  "webhook-test": WebhookTestScreen,
  "sales-test": SalesTestScreen,
  "test-inventory": TestInventoryScreen,
  "inventory-aging": InventoryAgingScreen,
  "inventory-migration": InventoryMigrationScreen,
};

function ComingSoon({ label, sectionDescription }: { label: string; sectionDescription: string }) {
  return (
    <div className="max-w-lg">
      <h1 className="text-xl font-semibold text-(--color-ink)">{label}</h1>
      <p className="mt-1 text-sm text-(--color-ink-tertiary)">{sectionDescription}</p>
      <div className="mt-6 rounded-md border border-dashed border-(--color-border-standard) p-6 text-sm text-(--color-ink-secondary)">
        Not ported yet — see the migration plan's phase breakdown.
      </div>
    </div>
  );
}

export function App() {
  const [activeItem, setActiveItem] = useState(NAV_SECTIONS[0].items[0].id);

  const section = NAV_SECTIONS.find(s => s.items.some(i => i.id === activeItem))!;
  const item = section.items.find(i => i.id === activeItem)!;
  const Screen = SCREENS[activeItem];

  return (
    <div className="flex min-h-screen">
      <Sidebar activeItem={activeItem} onSelect={setActiveItem} />
      <div className="flex flex-1 flex-col">
        <UserHeader />
        <main className="flex-1 bg-(--color-surface) p-8">
          {Screen ? <Screen /> : <ComingSoon label={item.label} sectionDescription={section.description} />}
        </main>
      </div>
    </div>
  );
}
