# Trim the Worker Epic

**Status**: ✅ COMPLETED (2026-11-01)
**Goal**: The sale worker's money path reads as what it does, with nothing it doesn't use

## Overview

`sale.worker.ts` accepts a Square payment in three shapes, but both producers (the webhook and the dev test-sale tool) send only `payload.object.payment`. Its sale path has about 50 step-by-step `debugLog` lines and a `console.error` before each refusal, which only repeat the thrown error. Several refusals carry the whole payment or job data in their context, which the failed-job logging rule (`failed-job.ts`) says never to keep. Recording a sale item's batch consumption queries the batches again for unit costs the FIFO walk already had, inside the sale's transaction, and silently records 0 for a missing one. The placeholder store a sale used to create was removed in the Sales Only After Cutover epic.

---

## One Payment Shape

Read the payment only from `payload.object.payment`.

**Requirements**:
- Given a job with the payment at `payload.object.payment`, should record the sale as before
- Given a job with the payment anywhere else, should refuse it as a missing payment

---

## Cut the Sale Path's Logging Noise

Remove the step-by-step `debugLog` calls and the `console.error` lines that repeat a thrown error, from the sale and order path. Keep logs that report something the error doesn't (an auto-covered shortfall, a pre-cutover skip, a return with nothing to take back).

**Requirements**:
- Given a refused job, should not keep the payment or job data in the error's context
- Given every existing worker test, should still pass unchanged

---

## Consumption Costs From the FIFO Walk

Carry each consumed batch's unit cost out of the FIFO walk and record it from there.

**Requirements**:
- Given a sale across two batches, should record each consumption at its own batch's cost, with no extra batch query
- Given the FIFO walk, should return each consumed batch's unit cost

---
