# Per-Store Loose Link Epic

**Status**: ✅ COMPLETED (2026-11-09)
**Goal**: each store pairs a box with its own suelto, so linking at one store never changes another

## Overview

`Product.looseProductId` is one link shared by every store, so linking a box at Oriente also links it at Lolita, though each store's suelto can be a different product (its own barcode and Square item). The link moves to a per-store row; piezas por caja (`Product.quantity`) stays on the box, the same physical box everywhere. The old column is removed in the same change so there is never a second link to disagree with. The iOS app builds its link screen on this contract.

---

## Store Link Model

A `ProductLooseLink` row per store and box, replacing `Product.looseProductId`.

**Requirements**:
- Given a box, should have at most one suelto per store; many boxes may share a suelto
- Given an existing link, should be copied to every store where both products are sold, then the column dropped
- Given a link added, changed or removed, should stamp the box so the phone's product sync resends it

---

## Link at the Session's Store

`PATCH /products/:id/loose-link` keeps its body and writes only the session store's link.

**Requirements**:
- Given a link at one store, should leave the other store's link as it was
- Given `looseProductId: null`, should remove only this store's link
- Given a box or suelto not sold at this store, should refuse with 400 "<name> no se vende en <store>"
- Given a link that loops back through this store's links, should refuse with 400; another store's links don't count
- Given `quantity`, should still set the box's piezas por caja for every store

---

## Read the Store's Link

**Requirements**:
- Given the product list, a product, or the phone's sync, should return `looseProductId` for the session's store, under the same field name
- Given a product created with a suelto, should link it at the store it was created at
- Given Abrir caja, should use the box's link at that store, and refuse when that store has none
- Given a sale short on sueltos, should open only boxes linked to that suelto at the sale's store
- Given the Sueltos screen, should say which store the link is set for
