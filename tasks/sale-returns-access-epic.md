# Sale Returns Access Epic

**Status**: ✅ COMPLETED (2026-10-30)
**Goal**: Staff see and change returns and pending lines only with the role they hold at that store, and the returns screens' rough edges are gone.

## Overview

From the 2026-10-30 review of `apps/api/src/sales/`. The role checks use the employee's role at their current store, but the store filters accept any store they are assigned to, so a manager at one store who is a cashier at another can read that store's returns (with their cost), its cash totals and pending lines, and match its lines. The products code already fixed the same gap (`assertActingAtOwnStore`, `isCashierAt`). Smaller: a stale docblock, cash totals keyed by store name and cut mid-day, unchecked body field types, untested branches, and a few nits. The owner decided a hand return after a Square amount-only refund needs no guard (not likely to happen).

---

## ✅ The role at the store being read or changed

**Requirements**:
- Given a non-owner reading the returns history or pending lines for a store other than their current one, should answer 403 (as product creation does)
- Given a non-owner matching a line sold at a store other than their current one, should answer 403
- Given the owner, should work at every store as today
- Given the check, should be one shared helper in `auth.guard.ts` used by products and sales, not a copy per controller

---

## ✅ Cash per day by store, whole days

**Requirements**:
- Given two stores with the same name, should total each store's cash apart (group by store id, show its name)
- Given the 31-day window, should start at the beginning of that Mexico City day, so the oldest day shows all its cash

---

## ✅ Return body checked before queueing

**Requirements**:
- Given a `reason` or `clientRequestId` that isn't a string, or a reason longer than a fixed limit, should answer 400 in Spanish instead of queueing a return the worker can't save

---

## ✅ Small fixes

**Requirements**:
- Given `record`'s docblock, should say the worker restocks and records the return (it no longer updates the sale)
- Given the returns history's limit, should be a named constant like the other lists
- Given no failed jobs, should skip the queries that look them up
- Given a failed job with no finish time, should leave its date empty rather than 1970

---

## ✅ Tests

**Requirements**:
- Given each case above, should be covered: a manager at another store (history, pending lines, match), the store filter on failed returns, the latest failure per line winning, two stores with one name, the whole oldest day, and each bad body field
