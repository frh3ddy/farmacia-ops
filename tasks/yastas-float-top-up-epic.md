# Yastás Float Top-Up Epic

**Status**: 📋 PLANNED
**Goal**: A store's Yastás balance in the app follows the real float, and a negative one is seen

## Overview

The app's Yastás balance can only fall: a Yastás sale through Square takes its amount off the store's wallet, but a top-up made at Yastás can't be recorded anywhere (the schema's `LOAD` movement is never written). So after go-live the balance drifts below the real float and goes negative even when the float is fine, and nothing says so. A sale is never refused for a short wallet: the payment and the Yastás operation already happened.

---

## Record a Top-Up

Let staff record a float top-up from Yastás as a `LOAD` movement that raises the store's balance.

**Requirements**:
- Given a top-up at a store, should record a `LOAD` movement and raise its balance by the same amount, in one transaction
- Given an amount of zero or less, should refuse it in Spanish
- Given a store with no opening balance yet, should refuse it, since the opening balance comes first
- Given a cashier, or someone not at that store, should refuse it, as wallet transfers are
- Given the Yastás screen, should let an owner, manager or accountant record a top-up on the store's balance card

---

## Negative Balance Warning

**Requirements**:
- Given a store's balance below zero, should warn on its balance card that a top-up may be missing, while still showing the balance
