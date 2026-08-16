import { useCallback, useEffect, useState, type ReactNode } from "react";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import type { CartItem, CreateTestSaleResult, ProductWithInventory, QueueStatus, SalesTestLocation } from "../../lib/dev-tools/types";

type StatusType = "success" | "error" | "info" | "warning";

/**
 * Ported from sales-test.html (vanilla JS). The legacy page had its own
 * ad-hoc auth: a `prompt()` asking for a session token pasted in by hand.
 * Now that it lives inside the real app, it just uses apiFetch like every
 * other screen — no separate token entry.
 */
export function SalesTestScreen() {
  const [locations, setLocations] = useState<SalesTestLocation[]>([]);
  const [locationId, setLocationId] = useState("");
  const [products, setProducts] = useState<ProductWithInventory[]>([]);
  const [search, setSearch] = useState("");
  const [productsLoading, setProductsLoading] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [status, setStatus] = useState<{ message: string; type: StatusType } | null>(null);
  const [tab, setTab] = useState<"response" | "logs">("response");
  const [result, setResult] = useState<CreateTestSaleResult | { error: string } | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | { error: string } | null>(null);
  const [creating, setCreating] = useState(false);

  const showStatus = useCallback((message: string, type: StatusType = "info") => {
    setStatus({ message, type });
    setTimeout(() => setStatus(null), 5000);
  }, []);

  useEffect(() => {
    apiFetch<{ success: boolean; data: SalesTestLocation[]; message?: string }>("/api/sales-test/locations")
      .then(body => setLocations(body.data))
      .catch((err: unknown) => showStatus(`Failed to load locations: ${err instanceof ApiError ? err.message : "unknown error"}`, "error"));
  }, [showStatus]);

  const fetchProducts = useCallback(() => {
    if (!locationId) {
      setProducts([]);
      return;
    }
    setProductsLoading(true);
    apiFetch<{
      success: boolean;
      data: ProductWithInventory[];
      summary?: { totalProducts: number; withSquareMapping: number; totalInventoryUnits: number };
    }>(`/api/sales-test/products?locationId=${locationId}`)
      .then(body => {
        setProducts(body.data);
        if (body.summary) {
          showStatus(
            `Loaded ${body.summary.totalProducts} products (${body.summary.withSquareMapping} with Square mapping, ${body.summary.totalInventoryUnits} total units)`,
            "info"
          );
        }
      })
      .catch((err: unknown) => showStatus(`Failed to load products: ${err instanceof ApiError ? err.message : "unknown error"}`, "error"))
      .finally(() => setProductsLoading(false));
  }, [locationId, showStatus]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  const updateCart = (product: ProductWithInventory, delta: number) => {
    if (!product.hasSquareMapping) {
      showStatus("This product needs a Square catalog mapping before it can be sold", "warning");
      return;
    }
    setCart(prev => {
      const existing = prev.find(c => c.productId === product.id);
      if (existing) {
        const nextQty = existing.quantity + delta;
        if (nextQty <= 0) return prev.filter(c => c.productId !== product.id);
        if (nextQty > product.totalInventory) {
          showStatus(`Maximum available: ${product.totalInventory}`, "warning");
          return prev.map(c => (c.productId === product.id ? { ...c, quantity: product.totalInventory } : c));
        }
        return prev.map(c => (c.productId === product.id ? { ...c, quantity: nextQty } : c));
      }
      if (delta > 0) {
        return [...prev, { productId: product.id, productName: product.displayName, quantity: 1, price: product.sellingPrice ?? 0 }];
      }
      return prev;
    });
  };

  const setCartQuantity = (product: ProductWithInventory, value: number) => {
    const qty = Math.min(Math.max(value, 0), product.totalInventory);
    setCart(prev => {
      if (qty <= 0) return prev.filter(c => c.productId !== product.id);
      const existing = prev.find(c => c.productId === product.id);
      if (existing) return prev.map(c => (c.productId === product.id ? { ...c, quantity: qty } : c));
      if (!product.hasSquareMapping) return prev;
      return [...prev, { productId: product.id, productName: product.displayName, quantity: qty, price: product.sellingPrice ?? 0 }];
    });
  };

  const createTestSale = async () => {
    if (!locationId) return showStatus("Please select a location", "warning");
    if (cart.length === 0) return showStatus("Please add products to cart", "warning");

    setCreating(true);
    try {
      const body = await apiFetch<{ success: boolean; message?: string } & Partial<{ data: CreateTestSaleResult }>>(
        "/api/sales-test/create",
        {
          method: "POST",
          body: JSON.stringify({
            locationId,
            lineItems: cart.map(item => ({ productId: item.productId, quantity: item.quantity })),
          }),
        }
      );
      setResult(body.data ?? { error: body.message ?? "Unknown response" });
      if (body.success) {
        showStatus("Test sale created successfully! Check worker logs for processing.", "success");
        setCart([]);
        setTimeout(fetchProducts, 1000); // inventory just changed — reload to reflect it
      } else {
        showStatus(body.message ?? "Failed to create test sale", "error");
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Unknown error";
      showStatus(`Error: ${message}`, "error");
      setResult({ error: message });
    } finally {
      setCreating(false);
    }
  };

  const checkQueueStatus = async () => {
    try {
      const body = await apiFetch<{ success: boolean; data: QueueStatus }>("/api/sales-test/queue-status");
      setQueueStatus(body.data);
    } catch (err) {
      setQueueStatus({ error: err instanceof ApiError ? err.message : "Unknown error" });
    }
  };

  const filteredProducts = products.filter(
    p => p.displayName.toLowerCase().includes(search.toLowerCase()) || (p.sku ?? "").toLowerCase().includes(search.toLowerCase())
  );
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  return (
    <div className="max-w-6xl">
      <h1 className="mb-1 text-xl font-semibold text-(--color-ink)">Sales Test</h1>
      <p className="mb-4 text-sm text-(--color-ink-tertiary)">Test the sales webhook processing with real inventory data.</p>

      {status && (
        <div
          className={`mb-4 rounded-md border px-4 py-2 text-sm ${
            {
              success: "border-(--color-success) bg-(--color-success-bg) text-(--color-success)",
              error: "border-(--color-destructive) bg-(--color-destructive-bg) text-(--color-destructive)",
              warning: "border-(--color-warning) bg-(--color-warning-bg) text-(--color-warning)",
              info: "border-(--color-border-standard) bg-(--color-surface-raised) text-(--color-ink-secondary)",
            }[status.type]
          }`}
        >
          {status.message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <Panel title="1. Select location">
            <select value={locationId} onChange={e => setLocationId(e.target.value)} className={inputClass}>
              <option value="">-- Select a location --</option>
              {locations.map(l => (
                <option key={l.id} value={l.id}>
                  {l.name} {l.hasSquareId ? "(Square)" : "(No Square)"}
                </option>
              ))}
            </select>
          </Panel>

          <Panel title="2. Select products">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search products…"
              className={`mb-3 ${inputClass}`}
            />
            {productsLoading ? (
              <p className="py-4 text-center text-sm text-(--color-ink-tertiary)">Loading products…</p>
            ) : !locationId ? (
              <EmptyState text="Select a location to view products." />
            ) : filteredProducts.length === 0 ? (
              <EmptyState text="No products found with inventory." />
            ) : (
              <div className="max-h-96 overflow-y-auto rounded-md border border-(--color-border-standard)">
                {filteredProducts.map(p => {
                  const inCart = cart.find(c => c.productId === p.id);
                  return (
                    <div
                      key={p.id}
                      className={`flex items-center justify-between gap-3 border-b border-(--color-border-subtle) p-3 last:border-b-0 ${
                        inCart ? "bg-(--color-accent)/5" : ""
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm font-medium text-(--color-ink)">
                          {p.displayName}
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              p.hasSquareMapping
                                ? "bg-(--color-accent)/10 text-(--color-accent)"
                                : "bg-(--color-surface-inset) text-(--color-ink-tertiary)"
                            }`}
                          >
                            {p.hasSquareMapping ? "Square" : "Local only"}
                          </span>
                        </div>
                        <div className="tabular text-xs text-(--color-ink-tertiary)">
                          SKU: {p.sku ?? "N/A"} · Price: ${p.sellingPrice?.toFixed(2) ?? "0.00"}
                        </div>
                      </div>
                      <span
                        className={`tabular shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                          p.totalInventory < 10
                            ? "bg-(--color-warning-bg) text-(--color-warning)"
                            : "bg-(--color-success-bg) text-(--color-success)"
                        }`}
                      >
                        {p.totalInventory} units
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          onClick={() => updateCart(p, -1)}
                          disabled={!inCart}
                          className="h-7 w-7 rounded-full border border-(--color-border-standard) text-sm disabled:opacity-40"
                        >
                          −
                        </button>
                        <input
                          type="number"
                          value={inCart?.quantity ?? 0}
                          min={0}
                          max={p.totalInventory}
                          onChange={e => setCartQuantity(p, parseInt(e.target.value) || 0)}
                          className="tabular w-14 rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-1 py-1 text-center text-sm"
                        />
                        <button
                          onClick={() => updateCart(p, 1)}
                          disabled={!p.hasSquareMapping}
                          title={!p.hasSquareMapping ? "Needs Square mapping" : undefined}
                          className="h-7 w-7 rounded-full border border-(--color-border-standard) text-sm disabled:opacity-40"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="3. Review cart">
            {cart.length === 0 ? (
              <EmptyState text="Add products to cart." />
            ) : (
              <div className="rounded-md bg-(--color-surface) p-3">
                {cart.map(item => (
                  <div key={item.productId} className="flex items-center justify-between border-b border-(--color-border-subtle) py-2 last:border-b-0">
                    <div>
                      <p className="text-sm font-medium text-(--color-ink)">{item.productName}</p>
                      <p className="tabular text-xs text-(--color-ink-tertiary)">
                        {item.quantity} × ${item.price.toFixed(2)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="tabular text-sm font-semibold text-(--color-ink)">${(item.price * item.quantity).toFixed(2)}</span>
                      <button
                        onClick={() => setCart(prev => prev.filter(c => c.productId !== item.productId))}
                        className="rounded-sm border border-(--color-border-standard) px-2 py-0.5 text-xs text-(--color-ink-tertiary) hover:text-(--color-destructive)"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
                <div className="tabular mt-2 flex justify-between border-t-2 border-(--color-accent) pt-2 text-base font-bold text-(--color-ink)">
                  <span>Total</span>
                  <span>${total.toFixed(2)}</span>
                </div>
              </div>
            )}
            {cart.length > 0 && (
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => setCart([])}
                  className="rounded-sm border border-(--color-border-standard) px-3 py-1.5 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface)"
                >
                  Clear cart
                </button>
                <button
                  onClick={createTestSale}
                  disabled={creating}
                  className="rounded-sm bg-(--color-success) px-3 py-1.5 text-sm font-medium text-(--color-accent-contrast) disabled:opacity-50"
                >
                  {creating ? "Processing…" : "Create test sale"}
                </button>
              </div>
            )}
          </Panel>

          <Panel title="4. Results">
            <div className="mb-3 flex gap-1">
              {(["response", "logs"] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex-1 rounded-sm border px-3 py-1.5 text-sm capitalize ${
                    tab === t
                      ? "border-(--color-accent) bg-(--color-accent) text-(--color-accent-contrast)"
                      : "border-(--color-border-standard) text-(--color-ink-secondary)"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            {tab === "response" ? (
              <pre className="max-h-72 overflow-auto rounded-md bg-(--color-ink) p-3 text-xs text-(--color-success)">
                {result ? JSON.stringify(result, null, 2) : "No results yet. Create a test sale to see results."}
              </pre>
            ) : (
              <div>
                <pre className="max-h-72 overflow-auto rounded-md bg-(--color-ink) p-3 text-xs text-(--color-success)">
                  {queueStatus ? JSON.stringify(queueStatus, null, 2) : "Worker logs will appear here after processing…"}
                </pre>
                <button
                  onClick={checkQueueStatus}
                  className="mt-2 rounded-sm border border-(--color-border-standard) px-3 py-1.5 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface)"
                >
                  Check queue status
                </button>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none";

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4">
      <h2 className="mb-3 text-sm font-semibold text-(--color-ink)">{title}</h2>
      {children}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="py-8 text-center text-sm text-(--color-ink-tertiary)">{text}</p>;
}
