# Product Barcode Epic

**Status**: 📋 PLANNED
**Goal**: scanning a box finds its product by its barcode, and the owner can fix a wrong SKU or barcode from the phone

## Overview

Scanning a box often finds nothing and the phone opens Nuevo Producto: Square keeps the box's barcode in the variation's `upc` (e.g. Buscapina: sku `8857379`, upc `3664798067460`), but the app never reads `upc`, so the exact search only matches SKU. Some products were also saved with the scanner's 14-digit form of the barcode as their SKU, and nothing lets the owner correct it. Catalog sync is migration-only, so existing barcodes come over in one import; after that the app is where they're edited, and each edit goes to Square so the register's scanner agrees.

---

## Barcode on Product

Add `Product.gtin` and match it in the scanner's exact search.

**Requirements**:
- Given two products with the same barcode, should save both (indexed, not unique — Square allows duplicates)
- Given an exact search, should match the SKU (any letter case) or the barcode, and report `exactMatch` for either
- Given the product list, detail and `GET /products/sync`, should include `gtin`, so the phone's offline cache matches scans
- Given a barcode set or changed, should stamp the product so the next delta sync sends it

---

## Barcode Import from Square

A one-off script reads every mapped variation's `upc` from Square and fills `gtin`.

**Requirements**:
- Given a product whose mapped variations carry one barcode, should save it
- Given a product whose variations carry different barcodes, should leave it empty and list it for the owner
- Given a product that already has a barcode, should leave it alone
- Given a run, should only read from Square, never write to it

---

## Barcode on Create

`POST /products` takes `gtin` and creates the Square variation with it as `upc`, so the register scanner finds the new item.

**Requirements**:
- Given a scanned code, should save it as the barcode only, not the SKU (a SKU is unique, a barcode two products may share), and send it as the new variation's `upc`
- Given a barcode that isn't 8, 12, 13 or 14 digits, should refuse with a Spanish 400 before writing anything
- Given a barcode another product already has, should still create it (barcodes aren't unique)

---

## Edit SKU and Barcode

`PATCH /products/:id` with `{ sku?, gtin? }`, owner only.

**Requirements**:
- Given a manager or cashier, should refuse with 403 (a SKU belongs to the product at every store)
- Given a SKU another product has, should refuse with 409, code `SKU_TAKEN`, and that product's id and name
- Given an empty string, should clear that field
- Given a barcode of 0 plus 13 digits, should save the 13 digits, as create does
- Given a change, should write the new `sku`/`upc` to every Square variation mapped to the product first, keeping the rest of each variation
- Given Square refuses or can't be reached, should change nothing and say so in Spanish
- Given a Yastás product or one not in Square, should save it in the app only

---
