# Adjustment Lot Choice Epic

**Status**: 📋 PLANNED, not started (Fredy, 2026-11-21: document only, build later)
**Goal**: let a merma leave from the lot it really came from, so a Vencido doesn't take units from a lot that hasn't expired

## Overview

Today every removal (`POST /inventory/adjustments` and the typed routes `/damage`, `/theft`, `/expired`, `/write-off`, a `/count-correction` down) takes stock oldest received first (`receivedAt ASC`, `inventory-adjustment.service.ts`), and the request has no lot field. A Vencido merma can then leave from a lot that hasn't expired, and the expired lot stays on the books. The iOS adjustment screen doesn't pick a lot for now.

## Optional batchId on removals

Add an optional `batchId` to `POST /inventory/adjustments` and the typed removal routes.

**Requirements**:
- Given a `batchId`, should take from that lot first, then continue oldest received first if it doesn't hold enough
- Given a lot of another product or another store, or an empty lot, should refuse with 400 (Spanish message) and change nothing
- Given no `batchId`, should behave exactly as today
- Given a `batchId` on an adjustment that adds stock (`/found`, `/return`, a count correction up), should refuse with 400: there is no lot to take from
