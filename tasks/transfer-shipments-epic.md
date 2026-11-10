# Transfer Shipments Epic

**Status**: ✅ COMPLETED (2026-11-10). Reviewed by dev-67; two web follow-ups open below.
**Goal**: send several products to another store in one go, received on send or confirmed on arrival

## Overview

A transfer moves one product, so sending a store's restock took one request per product, could fail halfway, and a retry after a timeout could ship twice. A shipment groups one transfer per product, sent all or nothing and once per `clientRequestId`. The iOS transfers screen is built on this contract (farmacia-ios `tasks/transfers-epic.md`, step 0).

---

## Send a Shipment

`POST /transfers/batch { toLocationId, clientRequestId, receiveOnSend, items: [{ productId, quantity }] }` from the session's store.

**Requirements**:
- Given several products, should ship them all or none, one transfer each, taking stock in product id order so overlapping sends don't deadlock
- Given `receiveOnSend` left out or not a boolean, should refuse with 400
- Given a resent `clientRequestId`, should answer with the first shipment and ship nothing again; from another store, should refuse with 409 `CLIENT_REQUEST_ID_REUSED`
- Given `receiveOnSend`, should receive every line at its sent quantity in the same step and tell Square once per transfer after it commits
- Given Square down during a receive on send, should still send, recording the failure on the transfer for the retry
- Given receive on send from someone without access to the destination (not OWNER), should refuse with 403 `RECEIVE_ON_SEND_NOT_ALLOWED`
- Given a bad send, should refuse with a code, naming the product when one is at fault: `NO_ITEMS`, `TOO_MANY_ITEMS` (over 100), `INVALID_ITEM`, `INVALID_QUANTITY`, `DUPLICATE_PRODUCT`, `SAME_LOCATION`, `DESTINATION_NOT_CUT_OVER`, `PRODUCT_NOT_SOLD_AT_LOCATION`, `INSUFFICIENT_STOCK { requested, available }`

---

## List and Receive Shipments

**Requirements**:
- Given `GET /transfers/shipments`, should list a store's shipments newest first, in transit while any of its transfers is
- Given `POST /transfers/shipments/:id/receive`, should receive every transfer still in transit, at its sent quantity unless a line is counted otherwise, and refuse with 409 when none is left
- Given the web "Nueva transferencia", should send through the batch, confirmed on arrival

---

## Follow-ups

From the reviews of 2026-11-10:

- [x] Tell iOS the origin-not-cut-over code is `LOCATION_NOT_CUT_OVER` (raised by the origin's TRANSFER_OUT, not in its code list)
- [x] Ask iOS whether its error decoder needs `statusCode`: no, every field is optional, it reads `message` then `error` and maps by status, then `code` (2026-11-10)
- [x] On a resent `clientRequestId`, answer only when the shipment's origin is the caller's store (dev-67: return 409 otherwise)
- [x] Note the ceiling of one transaction for up to 100 items (`ponytail:` comment): it holds the origin's stock rows while a sale may wait and time out
- [x] Test the duplicate-key recovery on its own (it and the lookup before the transaction each hide the other)
- [ ] Web: renew the request id when product, quantity or destination change (dev-67 #3: a lost response then an edited resend shows the edited values while the server answers with the first shipment), and test a failed send resent with the same id
- [ ] Web multi-product send form (the web sends one product through the batch today)
