import { useEffect, useState, type ReactNode } from "react";
import { Table, type Column } from "../../components/ui/Table";
import { RiskBadge } from "../../components/ui/RiskBadge";
import { LocationPicker } from "../../components/ui/LocationPicker";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import type {
  ActionableSignal,
  AgingSummary,
  BucketDistribution,
  CategoryAging,
  LocationAging,
  ProductAging,
  RiskLevel,
  SignalType,
} from "../../lib/reports/types";

const VIEWS = [
  { id: "summary", label: "Summary" },
  { id: "products", label: "Products" },
  { id: "locations", label: "Locations" },
  { id: "categories", label: "Categories" },
  { id: "signals", label: "Actionable signals" },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];

function BucketList({ buckets, valueKind }: { buckets: BucketDistribution[]; valueKind: "percent" | "cash" }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-(--color-ink-tertiary)">
      {buckets.map((b, i) => (
        <span key={i} className="tabular">
          {b.bucket.label}: {valueKind === "percent" ? `${b.percentageOfTotal.toFixed(0)}%` : `$${b.cashValue.toFixed(0)}`}
        </span>
      ))}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-(--color-ink-tertiary)">{label}</div>
      <div className="tabular mt-1 text-2xl font-semibold text-(--color-ink)">{value}</div>
    </div>
  );
}

export function InventoryAgingScreen() {
  const [view, setView] = useState<ViewId>("summary");
  const [locationId, setLocationId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [riskLevel, setRiskLevel] = useState<RiskLevel | "">("");
  const [severity, setSeverity] = useState<RiskLevel | "">("");
  const [signalType, setSignalType] = useState<SignalType | "">("");
  const [limit, setLimit] = useState("100");

  const [summary, setSummary] = useState<AgingSummary | null>(null);
  const [products, setProducts] = useState<ProductAging[]>([]);
  const [locations, setLocations] = useState<LocationAging[]>([]);
  const [categories, setCategories] = useState<CategoryAging[]>([]);
  const [signals, setSignals] = useState<ActionableSignal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (locationId) params.append("locationId", locationId);
    if (categoryId.trim()) params.append("categoryId", categoryId.trim());

    setLoading(true);
    setError(null);

    let request: Promise<void>;
    if (view === "summary") {
      request = apiFetch<AgingSummary>(`/inventory/aging/summary?${params}`).then(setSummary);
    } else if (view === "products") {
      if (riskLevel) params.append("riskLevel", riskLevel);
      if (limit.trim()) params.append("limit", limit.trim());
      request = apiFetch<{ products: ProductAging[] }>(`/inventory/aging/products?${params}`).then(body =>
        setProducts(body.products)
      );
    } else if (view === "locations") {
      request = apiFetch<{ locations: LocationAging[] }>(`/inventory/aging/location?${params}`).then(body =>
        setLocations(body.locations)
      );
    } else if (view === "categories") {
      request = apiFetch<{ categories: CategoryAging[] }>(`/inventory/aging/category?${params}`).then(body =>
        setCategories(body.categories)
      );
    } else {
      if (severity) params.append("severity", severity);
      if (signalType) params.append("type", signalType);
      if (limit.trim()) params.append("limit", limit.trim());
      request = apiFetch<{ signals: ActionableSignal[] }>(`/inventory/aging/signals?${params}`).then(body =>
        setSignals(body.signals)
      );
    }

    request
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : `Failed to fetch ${view}`))
      .finally(() => setLoading(false));
  }, [view, locationId, categoryId, riskLevel, severity, signalType, limit]);

  const productColumns: Column<ProductAging>[] = [
    { key: "productName", header: "Product" },
    { key: "categoryName", header: "Category", render: v => (v as string | null) ?? "-" },
    { key: "totalCashTiedUp", header: "Cash tied up", align: "right", render: v => <span className="tabular">${(v as number).toFixed(2)}</span> },
    { key: "totalUnits", header: "Units", align: "right", render: v => <span className="tabular">{v as number}</span> },
    { key: "oldestBatchAge", header: "Oldest age (days)", align: "right", render: v => <span className="tabular">{v as number}</span> },
    { key: "riskLevel", header: "Risk", render: v => <RiskBadge level={v as RiskLevel} /> },
    { key: "bucketDistribution", header: "Buckets", render: v => <BucketList buckets={v as BucketDistribution[]} valueKind="percent" /> },
  ];

  const locationColumns: Column<LocationAging>[] = [
    { key: "locationName", header: "Location" },
    { key: "totalCashTiedUp", header: "Cash tied up", align: "right", render: v => <span className="tabular">${(v as number).toFixed(2)}</span> },
    { key: "totalUnits", header: "Units", align: "right", render: v => <span className="tabular">{v as number}</span> },
    {
      key: "atRiskProducts",
      header: "At-risk products",
      align: "right",
      render: v => <RiskBadge level={(v as number) > 0 ? "HIGH" : "LOW"} />,
    },
    { key: "bucketDistribution", header: "Buckets", render: v => <BucketList buckets={v as BucketDistribution[]} valueKind="cash" /> },
  ];

  const categoryColumns: Column<CategoryAging>[] = [
    { key: "categoryName", header: "Category" },
    { key: "totalCashTiedUp", header: "Cash tied up", align: "right", render: v => <span className="tabular">${(v as number).toFixed(2)}</span> },
    { key: "totalUnits", header: "Units", align: "right", render: v => <span className="tabular">{v as number}</span> },
    { key: "averageAge", header: "Avg age (days)", align: "right", render: v => <span className="tabular">{(v as number).toFixed(1)}</span> },
    { key: "bucketDistribution", header: "Buckets", render: v => <BucketList buckets={v as BucketDistribution[]} valueKind="cash" /> },
  ];

  const signalColumns: Column<ActionableSignal>[] = [
    {
      key: "type",
      header: "Type",
      render: v => (
        <span className="rounded-full bg-(--color-accent)/10 px-2 py-0.5 text-xs font-medium text-(--color-accent)">
          {(v as string).replace(/_/g, " ")}
        </span>
      ),
    },
    { key: "severity", header: "Severity", render: v => <RiskBadge level={v as RiskLevel} /> },
    {
      key: "entityName",
      header: "Entity",
      render: (v, item) => (
        <div>
          <div className="font-medium">{v as string}</div>
          <div className="text-xs text-(--color-ink-tertiary)">{item.entityType}</div>
        </div>
      ),
    },
    { key: "message", header: "Message" },
    {
      key: "cashAtRisk",
      header: "Cash at risk",
      align: "right",
      render: v => <span className="tabular">{v != null ? `$${(v as number).toFixed(2)}` : "-"}</span>,
    },
    {
      key: "recommendedActions",
      header: "Actions",
      render: v => (
        <ul className="list-disc pl-4 text-xs">
          {(v as string[]).map((action, i) => (
            <li key={i}>{action}</li>
          ))}
        </ul>
      ),
    },
  ];

  const summaryColumns: Column<BucketDistribution>[] = [
    { key: "bucket", header: "Age range", render: v => (v as BucketDistribution["bucket"]).label },
    { key: "cashValue", header: "Cash value", align: "right", render: v => <span className="tabular">${(v as number).toFixed(2)}</span> },
    { key: "unitCount", header: "Units", align: "right", render: v => <span className="tabular">{v as number}</span> },
    {
      key: "percentageOfTotal",
      header: "Percentage",
      align: "right",
      render: v => <span className="tabular">{(v as number).toFixed(1)}%</span>,
    },
    {
      key: "percentageOfTotal",
      header: "Visual",
      render: v => (
        <div className="h-1.5 w-40 overflow-hidden rounded-full bg-(--color-surface-inset)">
          <div className="h-full rounded-full bg-(--color-accent)" style={{ width: `${v as number}%` }} />
        </div>
      ),
    },
  ];

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-(--color-ink)">Inventory Aging</h1>
      <p className="mb-4 text-sm text-(--color-ink-tertiary)">
        Slow-moving stock, cash tied up, and actionable signals — the first report in what becomes the dashboard.
      </p>

      <div className="mb-4 flex gap-1 border-b border-(--color-border-standard)">
        {VIEWS.map(v => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              view === v.id
                ? "border-(--color-accent) text-(--color-accent)"
                : "border-transparent text-(--color-ink-tertiary) hover:text-(--color-ink)"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Location">
          <LocationPicker value={locationId} onChange={setLocationId} allowAll allLabel="All locations" />
        </Field>
        <Field label="Category ID">
          <input
            value={categoryId}
            onChange={e => setCategoryId(e.target.value)}
            placeholder="Filter by category"
            className={inputClass}
          />
        </Field>
        {view === "products" && (
          <Field label="Risk level">
            <select value={riskLevel} onChange={e => setRiskLevel(e.target.value as RiskLevel | "")} className={inputClass}>
              <option value="">All</option>
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
              <option value="CRITICAL">Critical</option>
            </select>
          </Field>
        )}
        {view === "signals" && (
          <>
            <Field label="Severity">
              <select value={severity} onChange={e => setSeverity(e.target.value as RiskLevel | "")} className={inputClass}>
                <option value="">All</option>
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </Field>
            <Field label="Type">
              <select value={signalType} onChange={e => setSignalType(e.target.value as SignalType | "")} className={inputClass}>
                <option value="">All</option>
                <option value="AT_RISK">At risk</option>
                <option value="SLOW_MOVING_EXPENSIVE">Slow moving expensive</option>
                <option value="OVERSTOCKED_CATEGORY">Overstocked category</option>
              </select>
            </Field>
          </>
        )}
        {(view === "products" || view === "signals") && (
          <Field label="Limit">
            <input
              type="number"
              value={limit}
              onChange={e => setLimit(e.target.value)}
              min={1}
              max={500}
              className={`tabular ${inputClass}`}
            />
          </Field>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-2 text-sm text-(--color-destructive)">
          {error}
        </div>
      )}

      {loading ? (
        <p className="py-8 text-center text-sm text-(--color-ink-tertiary)">Loading…</p>
      ) : (
        <>
          {view === "summary" && summary && (
            <div>
              <div className="mb-6 grid grid-cols-2 gap-3">
                <StatTile label="Total cash tied up" value={`$${summary.totalCashTiedUp.toFixed(2)}`} />
                <StatTile label="Total units" value={String(summary.totalUnits)} />
              </div>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-(--color-ink-tertiary)">Aging buckets</h2>
              <Table data={summary.buckets} columns={summaryColumns} keyExtractor={b => b.bucket.label} />
            </div>
          )}
          {view === "products" && (
            <Table data={products} columns={productColumns} keyExtractor={p => p.productId} emptyMessage="No data available." />
          )}
          {view === "locations" && (
            <Table data={locations} columns={locationColumns} keyExtractor={l => l.locationId} emptyMessage="No data available." />
          )}
          {view === "categories" && (
            <Table data={categories} columns={categoryColumns} keyExtractor={c => c.categoryId} emptyMessage="No data available." />
          )}
          {view === "signals" && (
            <Table data={signals} columns={signalColumns} keyExtractor={(s, i) => `${s.entityId}-${i}`} emptyMessage="No signals found." />
          )}
        </>
      )}
    </div>
  );
}

const inputClass =
  "w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-(--color-ink-secondary)">{label}</label>
      {children}
    </div>
  );
}
