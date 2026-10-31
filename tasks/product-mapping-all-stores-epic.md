# Product Mapping for All Stores Epic

**Status**: ✅ COMPLETED (2026-10-31)
**Goal**: A product created in the app sells and costs correctly at every store it is sold in

## Overview

A product created on iOS or the web is put in Square at every store, but its catalog mapping is tied to the store that created it, so the worker can't match its Square sales at any other store and those sales go unrecorded. Mapping a product sold at every store globally (the shape catalog sync already uses) fixes new products. The unsynced-product sweep has to find those global placeholders. Production had no products created this way, so no backfill was needed.

---

## Global Mapping on Create

Create the mapping without a store when the product is sold at every store.

**Requirements**:
- Given a product sold at every store, should create its mapping with no store, so a Square sale at any store matches it
- Given a product sold only at the creating store, should keep the mapping tied to that store
- Given a later price change at one store, should add that store's own price and leave the all-stores price as it was

---

## Unsynced Sweep Finds Global Placeholders

Make the sweep that sends unsynced products to Square also pick up placeholders that have no store.

**Requirements**:
- Given a `local_` placeholder with no store, should send it to Square when the sweep runs at any store that sells the product
- Given a `local_` placeholder for a product sold only at another store, should leave it alone

---
