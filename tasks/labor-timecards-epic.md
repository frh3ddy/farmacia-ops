# Labor Timecards Epic

**Status**: ✅ COMPLETED (2026-10-29)
**Goal**: Payroll hours keep working when Square retires its Shifts endpoints, by reading and editing Timecards instead.

## Overview

`apps/api/src/labor/labor.service.ts` uses Square's **Shifts** endpoints for the payroll summary and for fixing worked hours:
- `client.labor.shifts.search` (summary, plus a probe when a period has none);
- `client.labor.shifts.get`, `client.labor.shifts.update` (`updateShiftTimes`);
- `client.labor.shifts.delete` (`deleteShift`).

They're served by `GET /labor/payroll-summary`, `PUT /labor/shifts/:id` and `DELETE /labor/shifts/:id`.

**Why:** Square deprecated Shifts in favour of **Timecards** (API `2025-05-21`), and the `square@46` SDK marks every `shifts.*` method `@deprecated`. Deprecated endpoints keep working at any `Square-Version` until Square retires them. A retired endpoint returns `410 GONE` whatever version is used, so this breaks payroll on Square's date, not ours. No retirement date was found as of 2026-10-28; check before planning the timing.

SDK 46 (already installed, `Square-Version: 2026-09-16`) exposes the replacements on `client.labor`: `searchTimecards`, `retrieveTimecard`, `updateTimecard`, `deleteTimecard` (and `createTimecard`). A `Timecard` has the same core shape the code reads today: `teamMemberId`, `startAt`, `endAt`, `wage`, `breaks`, `status`.

**Open questions** — answered 2026-10-29:
- The iOS app calls `PUT/DELETE /labor/shifts/:id` and reads `shiftId` (`PayrollViewModel.swift`); the web app doesn't use labor routes. Routes and response field names stay; only the Square calls behind them change.
- Square's reference pages give Shifts a retirement date of **2026-05-21** (`410 GONE` after it, at any version), already past. The connected Square MCP account (USD, Chicago — not the pharmacy's) lists no `shifts` method and answers `searchTimecards`; production's current behaviour wasn't checked. Urgent either way.
- Today an unknown id answers 502, not 404 (Square throws its 404 and the catch turns it into 502); the edit and delete should answer 404.

---

## ✅ Read hours from Timecards

The payroll summary reads Timecards instead of Shifts.

**Requirements**:
- Given a team member and a period, should total worked and paid hours from `searchTimecards` exactly as the Shifts version does today (same breaks, wage and rounding handling)
- Given a period with no timecards, should give the same answer and log the same probe as today
- Given Square paginating the results, should follow every page before totalling

---

## ✅ Edit and delete hours through Timecards

Fixing a worked shift updates or deletes its Timecard.

**Requirements**:
- Given new start and/or end times, should update the timecard through `retrieveTimecard` + `updateTimecard`, keeping its other fields and its version
- Given a delete, should delete the timecard through `deleteTimecard`
- Given an unknown id, should answer 404 (today it answers 502)
- Given the existing routes, should keep `PUT/DELETE /labor/shifts/:id` working for the apps unless the open question decides to rename them

---

## ✅ Remove the Shifts calls

**Requirements**:
- Given the codebase, should have no remaining `client.labor.shifts.*` call (grep), so nothing breaks on Square's retirement date
- Given the labor tests, should cover the summary, the edit and the delete against a recorded Square client
