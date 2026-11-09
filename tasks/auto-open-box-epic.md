# Auto Open Box Epic

**Status**: ✅ COMPLETED (2026-11-08)
**Goal**: a sale that runs out of sueltos opens a linked box automatically, the same way "Abrir caja" does

## Overview

When a Square sale needs more sueltos than are in stock, the worker makes up the missing pieces at a guessed cost (`AUTO_SALE_COVER`). The box that was really opened stays counted as sealed, in the app and in Square, and the sueltos' cost is not the box's. Instead, the worker asks the api to open the box with the real "Abrir caja" code (box FIFO cost, caducidad, Square update), then costs the sale from those sueltos. Whatever can't be opened falls back to today's cover, labeled, so a sale is never lost. Manual "Abrir caja" stays as it is.

---

## Cover Sueltos From Boxes

An api service method that, given a store, a suelto product, the pieces a sale needs and a request key, opens just enough boxes through the existing break-bulk code.

**Requirements**:
- Given 3 pieces needed, none in stock and boxes of 10, should open one box and leave 10 sueltos
- Given sueltos already in stock, should open boxes only for what they don't cover, counted after taking the product's stock lock
- Given two covers of the same suelto at once, should take turns on that lock, so the second sees the first's sueltos and never opens a box the sale didn't need
- Given more pieces needed than one box holds, should open as many boxes as cover them, and no more than the store has
- Given several box products linked to the suelto, should open from the one whose stock expires soonest; no caducidad last, then oldest received, then id
- Given no linked box with stock at that store, should open nothing and say so, not refuse
- Given the same request key again, should return the first opening and open nothing more
- Given a request key, should store it on the adjustments under an `auto-open:` prefix, so it can never clash with another client's key
- Given a manual "Abrir caja", should behave exactly as before

---

## Internal Endpoint for the Worker

Expose the cover method on an api route that only the worker can call, over Railway's private network, with a secret shared by the two services.

**Requirements**:
- Given a missing, wrong or different-length secret, should refuse with 401 (lengths compared before `crypto.timingSafeEqual`)
- Given a staff session token and no secret, should refuse
- Given the secret is not configured on the api, should refuse every call rather than accept any
- Given the api or the worker starts, should log whether the secret is set (never its value)
- Given the deployed environment, should be reached from the worker over `api.railway.internal` (the api listens on `::`)

---

## Open a Box on a Suelto Shortfall

Before the sale's database transaction, the worker sums each suelto product's pieces across the payment's lines and, when stock is short and a linked box has stock, calls the endpoint; then it costs the sale as usual.

**Requirements**:
- Given a sale of 3 sueltos with none in stock and a box of 10, should record the sale at the box's cost and leave 7 sueltos
- Given one payment with two lines of the same suelto, should ask once for their total, under one key per payment and product
- Given a sale that is retried, should not open a second box
- Given the api is unreachable on a try that is not the job's last, should fail the try so it retries
- Given the api is unreachable on the job's last try, should record the sale with today's cover, labeled as a box not opened, rather than lose it
- Given the api committed an opening but its response was lost, should find the opening by its `auto-open:…:in` key and use it, never cover the same pieces again
- Given any failure of the cover call on the job's last try (unreachable, timeout, 5xx, a deadlock abort), should check for the `:in` opening first, then fall back, logging why at warn level
- Given pieces still short after the openings (no box, or not enough boxes), should cover the rest as today (`AUTO_SALE_COVER`), labeled

---

## Review Automatic Openings

Show the owner and manager the boxes opened by a sale and the shortfalls covered without a box, so a miscounted shelf or a missed opening is caught.

**Requirements**:
- Given a box opened by a sale, should be labeled as automatic and show the sale that caused it
- Given a shortfall covered without opening a box, should be listed too, with why (no box, not enough boxes, api unreachable)
- Given an automatic opening that was wrong, should be fixed with the existing manual adjustments; there is no undo (the sale always uses some of the opened sueltos, so an undo would almost never apply)
