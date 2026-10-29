# Plan

- ✅ [Auth Guard Cleanup](tasks/auth-guard-cleanup-epic.md) — remove `SessionGuard`, single role check, typed guarded request
- ✅ [Inventory Integrity](tasks/inventory-integrity-epic.md) — nightly check that the books add up and every Square payment has its sale; removes the always-"reconciled" report
- ✅ [Worker Hardening](tasks/worker-hardening-epic.md) — keep test sales out of production stock, fix Yastás payments in the sales check and multi-line orders, test the sale mapping, clean logs and dead code
- ✅ [Dev Tools in Production](tasks/dev-tools-production-epic.md) — test sales, test inventory, catalog cleanup and full wipe refused in production
- 📋 [Sale Accuracy](tasks/sale-accuracy-epic.md) — custom-amount lines matched later, Square refunds and hand returns put stock and revenue back
- ✅ [Stock Movement Safety](tasks/stock-movement-safety-epic.md) — transfers and break-bulk move all their stock or none; a transfer's failed Square sync can be retried
- 📋 [Labor Timecards](tasks/labor-timecards-epic.md) — move payroll hours from Square's deprecated Shifts endpoints to Timecards before Square retires them
