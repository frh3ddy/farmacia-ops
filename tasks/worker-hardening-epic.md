# Worker Hardening Epic

**Status**: 📋 PLANNED
**Goal**: Every real Square payment is recorded exactly once, test sales never touch production stock, and the sale processor's money logic is tested and readable.

## Overview

A review of `apps/worker` (2026-10-27) found that the Dev Tools test sale writes real `Sale` rows and FIFO consumption in production, that the nightly sales check will flag every Yastás-only payment as lost (they create a `YastasOperation`, never a `Sale`, per vision.md), and that an order with two Yastás lines can never be recorded (`YastasOperation.squareId` is unique). `sale.worker.ts` — the repo's top churn hotspot, 1,044 lines — has no tests beyond the pure FIFO walk, and failed jobs log full Square payments (card details, buyer email). About 450 lines of `catalog.sync.ts` are dead: the api has its own catalog sync.

---

## Keep test sales out of production stock

`POST /api/sales-test/create` (OWNER, MANAGER) queues a mock `payment.created` carrying `_testOrderData`, so the worker skips Square and records a real sale with id `test_payment_…`, consuming real batches and adding revenue. The integrity check can't see it: it only looks for payments missing a sale. Decided 2026-10-27: block it in production only; local and staging keep it.

**Requirements**:
- Given the production environment, should refuse to create a test sale and say why
- Given the web app in production, should hide the Dev Tools → Sales Test screen
- Given a non-production environment, should keep test sales working as today
- Given existing `test_payment_…` sales in production, should list them for the owner to decide on (no automatic deletion)

---

## Count Yastás payments as recorded

The sales check counts a payment as recorded only when a `Sale` has its id; a Yastás-only payment creates a `YastasOperation` instead.

**Requirements**:
- Given a completed Square payment with a `YastasOperation` of the same `squareId` and no `Sale`, should not report it
- Given a payment with neither, should still report it as lost or failed job

---

## Test the sale line mapping

The mapping from Square order lines to sale items and Yastás lines (`processSaleJob`, lines 649–823) has no tests, and the next task changes it.

**Requirements**:
- Given the mapping, should live in a pure function (order lines + resolved mappings → sale items, Yastás lines, skipped lines) with the Square and DB reads outside it
- Given a quantity and a total, should price each unit as total ÷ quantity
- Given a non-inventory mapping without an employee, should fail with a validation error
- Given a line with no catalog item, should report it as skipped instead of only warning (input for the open question on custom amounts)
- Given the sale transaction, should have one Postgres-backed test covering a sale, a shortfall auto-cover and a Yastás line (api's `*.pg.spec.ts` pattern)

---

## Record orders with several Yastás lines

Each Yastás line creates a `YastasOperation` with the payment id, and `squareId` is unique, so the second line rolls back the whole sale and every retry fails. Rare, but it happens (confirmed 2026-10-27).

**Requirements**:
- Given an order with two Yastás lines, should record one operation and one wallet movement per line
- Given a redelivered webhook for such an order, should record nothing twice
- Given existing operations, should keep them valid through the schema change (e.g. unique on payment id + line uid)

---

## Log without payment data or secrets

**Requirements**:
- Given a failed sale job, should log its id, payment id, attempt and error — not the job data
- Given failed jobs at startup, should log the same, not the payment JSON
- Given startup, should not print any part of a `SQUARE_*` value (present or missing only)
- Given a missing payment in the payload, should log the job id, not the payload

---

## Remove dead and duplicated code

**Requirements**:
- Given `catalog.sync.ts`, should delete everything except the Square client, which moves to one `square-client.ts` used by the sale processor and the sales check
- Given the sales queue's `attempts`/`backoff` in `worker.config.ts`, should delete them (jobs take the api producer's options, `sale.queue.ts`)
- Given `sale.worker.ts`, should drop the `FIFOCostResult` alias, the misplaced docblock, the repeated payment and line-item checks, the unreachable `UnmappedVariationError` branch, the optional `tx` parameters, and use `Prisma.TransactionClient` instead of the repeated `Omit<PrismaClient, …>`
- Given a `SaleValidationError` thrown inside the transaction, should keep its type instead of becoming `DatabaseTransactionError: Unknown error`
- Given `worker.ts`, should drop the empty `if` and the unconditional `[DEBUG]` startup lines

---

## Open questions (decide before a follow-up epic)

- **Custom amounts**: are they used at the till? Today a line with no catalog item is skipped, so the sale's revenue is short; an all-custom order fails.
- **Refunds and returns**: nothing handles them, so a returned item never goes back to stock and its revenue stays. How are returns done today?
- **Payment status**: the worker records any `payment.created` without checking `status`. Check one real event to see whether a non-completed payment can arrive.
- **Revenue and tax**: sale price is the line's `totalMoney`, which includes tax. Is revenue meant to include IVA?
