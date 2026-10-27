# Plan

- ✅ [Auth Guard Cleanup](tasks/auth-guard-cleanup-epic.md) — remove `SessionGuard`, single role check, typed guarded request
- ✅ [Inventory Integrity](tasks/inventory-integrity-epic.md) — nightly check that the books add up and every Square payment has its sale; removes the always-"reconciled" report
- 📋 [Worker Hardening](tasks/worker-hardening-epic.md) — keep test sales out of production stock, fix Yastás payments in the sales check and multi-line orders, test the sale mapping, clean logs and dead code
