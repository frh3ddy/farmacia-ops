# Net Shrinkage Epic

**Status**: ✅ COMPLETED (2026-10-31) — `9bf3c62`, tests `e81bd0f` (merge `8da1284`); iOS `2c6422c`, `9a32f6b`
**Goal**: Merma in the P&L is what the store actually lost, so a miscount fixed later is no longer a loss

## Overview

The P&L counted every stock removal as merma and nothing that came back, so a count corrected down and later back up stayed a loss. Merma is now net: losses minus recovered stock. The API sends both parts so screens show "Merma" (losses) and "Mercancía recuperada" (recovered) apart and never a negative merma.

---

## The Rule

All figures are at cost (`totalCost`), for the store and dates asked for.

| Field | What it sums |
|---|---|
| `shrinkageLosses` | Every adjustment with negative quantity, except stock moves (`TRANSFER_*`, `BREAK_BULK_*`) |
| `shrinkageRecovered` | Positive `FOUND` and positive `COUNT_CORRECTION` (`SHRINKAGE_RECOVERY_TYPES`) |
| `shrinkage` | `shrinkageLosses − shrinkageRecovered`; can be negative |
| `operatingExpenses.total` | Expenses + net `shrinkage` |

**Decided:**
- Any count correction that goes up counts as recovered, even when nothing was lost earlier in the same period. A recount that finds stock the app never recorded lowers that period's merma, and can make it negative.
- `RETURN` (customer stock back) and `AUTO_SALE_COVER` (stock never received in the app) are not recovered losses and stay out.

**Where:** `getProfitAndLossReport` (`inventory-reports.service.ts`), passed through by `GET /inventory/reports/profit-loss` and `GET /inventory/reports/dashboard` (`operatingExpenses`).

---

## Requirements

- Given a recount down 5 then up 5, 2 stolen and 1 found, plus a customer return and a sale cover, should report merma 10 (losses 70, recovered 60) and leave the return and the sale cover out
- Given stock moves, should leave them out of losses and recoveries

## Clients

- iOS (`farmacia-ios` `2c6422c`): the dashboard card and the P&L report show Merma = `shrinkageLosses` and a "Mercancía recuperada" row when it is above 0; with an older server (no `shrinkageLosses`) they show the single net Merma row.
