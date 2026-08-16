import { useState } from "react";
import { SupplierManagement } from "./suppliers/SupplierManagement";
import { SupplierProducts } from "./suppliers/SupplierProducts";
import { SupplierCostHistory } from "./suppliers/SupplierCostHistory";

const TABS = [
  { id: "management", label: "Management" },
  { id: "products", label: "Supplier products" },
  { id: "cost-history", label: "Supplier cost history" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function SuppliersScreen() {
  const [tab, setTab] = useState<TabId>("management");

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold text-(--color-ink)">Suppliers</h1>
      <div className="mb-6 flex gap-1 border-b border-(--color-border-standard)">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? "border-(--color-accent) text-(--color-accent)"
                : "border-transparent text-(--color-ink-tertiary) hover:text-(--color-ink)"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "management" && <SupplierManagement />}
      {tab === "products" && <SupplierProducts />}
      {tab === "cost-history" && <SupplierCostHistory />}
    </div>
  );
}
