# Products Review Cleanup Epic

**Status**: 📋 PLANNED
**Goal**: The products endpoints reject bad input with a 400, and the obvious duplication and noise are gone.

## Overview

Smaller issues from the 2026-10-29 review of `apps/api/src/products/` (finding 8).

---

## 📋 Input checks

**Requirements**:
- Given a loose-product link with a `quantity` that isn't a whole number above 0, should answer 400 instead of 500
- Given a loose-product link that would make a product its own loose product, directly or through the linked product (A↔B), should answer 400
- Given `setSearchAliases` or `setCategorySymptomKeywords` with a body that isn't an array of strings, should answer 400
- Given `setYastasMapping` turning off inventory tracking for a product with stock, should answer 400 with a Spanish message, so the stock isn't silently stranded
- Given `sync-to-square` and the product list filters, should use typed bodies and `Prisma.ProductWhereInput` instead of `any`

---

## 📋 Remove duplication and noise

**Requirements**:
- Given the product list, should drop the per-product debug log
- Given the supplier-catalog handler, should move its Prisma query from the controller into the service

---
