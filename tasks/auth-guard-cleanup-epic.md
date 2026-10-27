# Auth Guard Cleanup Epic

**Status**: 📋 PLANNED
**Goal**: One guard path per request, with typed requests, and no dead auth code.

## Overview

Every api route depends on `apps/api/src/auth/guards/auth.guard.ts`, but it still carries an unused guard, a role check that runs twice on most routes, and untyped requests, so a typo in `req.currentLocation` or a guard wired the wrong way compiles and ships silently. Found in the 2026-10-26 aidd-review of the location-access/device-binding work (finding 5).

---

## Remove SessionGuard

`SessionGuard` duplicates `AuthGuard`'s session logic and no route uses it.

**Requirements**:
- Given no route uses `SessionGuard`, should delete it from `auth.guard.ts`, `auth.module.ts` providers/exports and `auth/index.ts`

---

## Single role check

`@UseGuards(AuthGuard, RoleGuard)` checks roles twice, since `AuthGuard` already enforces `@Roles`.

**Requirements**:
- Given a route guarded by `AuthGuard`, should enforce `@Roles` exactly once per request
- Given the guard change, should keep every existing `@Roles` restriction (the route-guards and auth-controller specs still pass)

---

## Typed guarded request

Guards, helpers and handlers take `request: any` / `req: any`.

**Requirements**:
- Given a handler behind `AuthGuard`, should read `session`, `employee`, `currentLocation` and `accessibleLocations` from one shared request type exported next to the guards (replacing `AuthedRequest` in `auth.controller.ts`)
- Given `assertLocationAccess` and `scopedLocationId`, should take that type instead of `any`

---
