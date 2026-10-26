# Project Vision

## Overview

farmacia-ops is private back-office tooling for one multi-location
pharmacy in Mexico that sells through Square POS. Square stays the cash register;
this app is where the owner and managers see what the business actually earns:
true per-product cost (FIFO), COGS and gross margin, inventory value and aging,
expenses, and P&L — per location and combined. It is built and run by a solo
developer, and its users are the pharmacy's own staff (owner, managers,
accountant, cashiers), working in Spanish.

## Goals

- Every sale recorded from Square is costed correctly, with FIFO consumption of real
  inventory batches, so margin and P&L can be trusted.
- No sale is ever silently lost between Square and the app (webhooks, queue, worker).
- Bring each location onto the system once, through the historical-cost cutover: real
  opening costs and prices for every product, reviewed and approved by the owner.
- Day-to-day inventory operations — receiving, adjustments, transfers, break-bulk,
  reconciliation — keep stock and cost true to the shelf.
- Give the owner reports they act on: inventory valuation and aging, COGS/margin,
  expenses, P&L, Yastás float and commissions.
- Keep running costs minimal (one api + one worker on Railway, Postgres, Redis).

## Non-Goals (Out of Scope)

- Replacing Square as the point of sale or payment processor.
- A public or multi-tenant product. One business; no signup, billing, or tenants.
- Customer-facing features (e-commerce, loyalty, patient records, prescriptions).
- Treating Yastás banking-correspondent operations as sales: they never touch
  `Sale`, `SaleItem`, `InventoryConsumption`, or FIFO cost.
- Hand-maintained architecture docs — the graphify graph (`graphify-out/`) is the map.

## Key Constraints

- **FIFO is ordered by `Inventory.receivedAt ASC`, never `createdAt`** — migrated and
  backfilled batches have a lagging `createdAt` that would mis-cost COGS.
- **Square is the source of truth for the catalog, locations, and sales.** The app
  syncs from it, and only writes back on deliberate actions (prices, cutover deletions).
  Square's REST API is date-versioned; use the current `SquareClient` SDK.
- **Sales must be durable end to end:** a Square webhook is answered 2xx only after
  the event is queued; failed jobs are kept for replay; processing is idempotent
  on Square's `event_id`.
- **Money and cost paths need tests** (FIFO, COGS, cutover, price/cost writes);
  `npm test` must pass before every push.
- **Least access by role and location:** every endpoint is authenticated unless it is
  deliberately public (setup, health, signed webhook); non-owners only see and change
  their own location's data.
- Stack: npm workspaces monorepo — NestJS api (also serves the web build), BullMQ worker,
  Vite + React 19 web, Prisma 7 on PostgreSQL, Redis. Deployed on Railway; infra in
  `.railway/railway.ts`.

## Architectural Decisions

- **One api process serves the REST API and the built web app** — no separate frontend
  deploy. Migrations run in Railway's pre-deploy step, not at boot.
- **Sales go webhook → Redis queue → worker**, so Square gets a fast response and a
  slow or failing sale is retried instead of dropped.
- **One shared Prisma schema** for api and worker.
- **Cutover work is derived, not counted:** the extraction queue is "mapped products
  minus this session's decisions", so pausing, batch size, or catalog changes can't
  make progress drift; earlier decisions carry into new sessions.
- **Cost is per product; stock is per location.** Approved costs carry across
  locations; discards are a per-location decision.

## User Experience Principles

- Spanish UI for staff; plain words, not accounting or developer jargon.
- Numbers must be explainable: a cost, margin, or total can be traced to the batches,
  approvals, and sales behind it.
- Destructive or irreversible actions (wipes, cutover execution, Square deletions)
  are owner-only and confirmed explicitly.
- Long tasks (cutover review of thousands of products) are resumable and never lose
  progress.
- Dense, calm back-office screens over decoration.

## Success Criteria

- Every Square payment appears as a costed sale; zero lost or double-counted sales.
- Margin and P&L per location match the owner's own checks.
- All locations completed the cutover with approved costs for every stocked product.
- Inventory on hand and its value match physical counts within the shrinkage expected.
- Hosting cost stays minimal (a few dollars a month on Railway).
