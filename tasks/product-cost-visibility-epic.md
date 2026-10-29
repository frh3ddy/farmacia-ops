# Product Cost Visibility Epic

**Status**: ✅ COMPLETED (2026-10-29)
**Goal**: Cashiers never see what the pharmacy pays for a product.

## Overview

CASHIER can read a product's supplier costs (`GET /products/:id/suppliers`) and full cost history (`GET /products/:id/cost-history`), and `GET /products/:id` returns `averageCost` and the last 10 receivings with their unit cost to every role. The owner decided cashiers must not see costs. Found in the 2026-10-29 review of `apps/api/src/products/` (finding 7). The inventory reports already keep costs from cashiers.

---

## ✅ Cost endpoints closed to cashiers

**Requirements**:
- Given a CASHIER, `GET /products/:id/suppliers` and `GET /products/:id/cost-history` should answer 403
- Given an OWNER, MANAGER or ACCOUNTANT, should answer as today
- Given these handlers, should move their Prisma queries from the controller into the service

---

## ✅ Product detail without costs for cashiers

**Requirements**:
- Given a CASHIER reading `GET /products/:id`, should omit `averageCost` and the receivings' unit costs, and keep stock and selling price
- Given any other product endpoint a CASHIER can call (list, catalog search, counts), should return no cost field
- Given the iOS `EditPriceView`, which reads `averageCost`, should confirm it handles a missing value, or that cashiers can't open it (check in `farmacia-ios`)

---
