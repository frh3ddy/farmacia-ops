export type NavItem = {
  id: string;
  label: string;
  /** Phase this tool lands in — placeholder panel is shown until then. */
  status: "ready" | "planned";
};

export type NavSection = {
  id: string;
  label: string;
  description: string;
  items: NavItem[];
};

// Mirrors the IA in the plan: grouped by actual task, not alphabetically.
// Populated as each phase ports its screens (see plan phases 2-5).
export const NAV_SECTIONS: NavSection[] = [
  {
    id: "ops",
    label: "Ops",
    description: "Reference data and day-to-day sync",
    items: [
      { id: "locations", label: "Locations", status: "ready" },
      { id: "catalog-search", label: "Catalog Search", status: "ready" },
      { id: "products", label: "Products", status: "ready" },
      { id: "add-product", label: "Add Product", status: "ready" },
      { id: "break-bulk", label: "Sueltos", status: "ready" },
      { id: "suppliers", label: "Suppliers", status: "ready" },
      { id: "catalog-mappings", label: "Catalog Mappings", status: "ready" },
      { id: "catalog-sync", label: "Catalog Sync", status: "ready" },
      { id: "devices", label: "Devices", status: "ready" },
    ],
  },
  {
    id: "cutover",
    label: "Cutover",
    description: "One-time historical cost migration",
    items: [
      { id: "inventory-migration", label: "Inventory Migration", status: "ready" },
      { id: "cutover-overview", label: "Cutover Overview", status: "planned" },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    description: "Read-only metrics — grows into the dashboard",
    items: [{ id: "inventory-aging", label: "Inventory Aging", status: "ready" }],
  },
  {
    id: "dev-tools",
    label: "Dev Tools",
    description: "Testing and seeding — not production actions",
    items: [
      { id: "webhook-test", label: "Webhook Test", status: "ready" },
      { id: "sales-test", label: "Sales Test", status: "ready" },
      { id: "test-inventory", label: "Test Inventory", status: "ready" },
    ],
  },
];
