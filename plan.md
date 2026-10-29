# Plan

- ✅ [Auth Guard Cleanup](tasks/auth-guard-cleanup-epic.md) — remove `SessionGuard`, single role check, typed guarded request
- ✅ [Inventory Integrity](tasks/inventory-integrity-epic.md) — nightly check that the books add up and every Square payment has its sale; removes the always-"reconciled" report
- ✅ [Worker Hardening](tasks/worker-hardening-epic.md) — keep test sales out of production stock, fix Yastás payments in the sales check and multi-line orders, test the sale mapping, clean logs and dead code
- ✅ [Dev Tools in Production](tasks/dev-tools-production-epic.md) — test sales, test inventory, catalog cleanup and full wipe refused in production
- 📋 [Sale Accuracy](tasks/sale-accuracy-epic.md) — custom-amount lines matched later, Square refunds and hand returns put stock and revenue back
- ✅ [Stock Movement Safety](tasks/stock-movement-safety-epic.md) — transfers and break-bulk move all their stock or none; a transfer's failed Square sync can be retried
- ✅ [Square Sync Lookup and List Limits](tasks/square-sync-and-list-limits-epic.md) — stock syncs use the product's real Square item, not a `local_` placeholder; inventory lists and COGS stay bounded
- ✅ [Inventory Review Cleanup](tasks/inventory-review-cleanup-epic.md) — selling prices must be numbers, replay checks agree, transfer receipts checked before claiming, comments that only restate code removed
- ✅ [Labor Timecards](tasks/labor-timecards-epic.md) — move payroll hours from Square's retired Shifts endpoints to Timecards
- ✅ [Product Price Sync](tasks/product-price-sync-epic.md) — a price change never hides the item at other stores; all-stores price or one store's own price; owner-only for all stores; no duplicate Square items
- ✅ [Product Cost Visibility](tasks/product-cost-visibility-epic.md) — cashiers never see supplier costs, cost history or average cost
- ✅ [Product Create Safety](tasks/product-create-safety-epic.md) — initial stock respects the cutover; input checked before writing; no orphan or duplicate Square items
- 📋 [Products Review Cleanup](tasks/products-review-cleanup-epic.md) — loose-link, alias and Yastás input checks; typed bodies; duplicated branch and debug log removed
