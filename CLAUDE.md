# farmacia-ops

Backend + back-office tooling for a multi-location pharmacy running on Square POS.
npm workspaces monorepo: `apps/api` (NestJS REST + serves the web build), `apps/worker`
(BullMQ — turns Square `payment.created` webhooks into FIFO-costed sales/inventory
records), `apps/web` (Vite + React 19 back-office suite, builds into `apps/api/public`).
Data: PostgreSQL via Prisma (`prisma/schema.prisma`, shared by api + worker), Redis for the queue.

> Global rules live in `~/dev/CLAUDE.md` and `~/CLAUDE.md`. This file is project-specific only.

## When working on X, read Y

- **Architecture / domain model / "where does X live"** → `graphify query "<question>"` (graph at `graphify-out/`), then `graphify-out/wiki/index.md`. Don't browse raw source blind.
- **Square API code** (payments, Orders, Catalog, Inventory, webhooks) → the `square-integration` skill first — the REST API is date-versioned and the Node SDK had a breaking `Client` → `SquareClient` rename.
- **DB questions** (inventory value, FIFO batches, COGS/margin, P&L, cutover) → the `farmacia-ops-data-analyst` skill.
- **NestJS patterns** → the `nestjs-best-practices` skill. **React/TS** → `react-dev` / `typescript-react-reviewer`. **Back-office UI** → `interface-design`.
- After changing code, run `graphify update .` (AST-only, no API cost).

## Workflow

- Branch: `feature/{desc}` or `fix/{desc}` — never develop on `main`.
- Commit: `{type}: {description}` (feat/fix/refactor/test/docs/chore).
- Commit or push only when asked.

## Build & test

- Install: `npm install` (runs `prisma generate` on postinstall)
- Local infra: `npm run db:up` (Postgres + Redis via Docker), `npm run db:down`
- Migrations: `npm run prisma:migrate:dev`
- Build all: `npm run build` — worker, then api, then web
- Dev: `npm run dev:api` / `npm run dev:worker` / `npm run dev:web`

## Local test

```
npm test
```

Runs the api, web, and worker workspace test suites. Must pass before push.

## Rules

- FIFO consumption order is `Inventory.receivedAt ASC` — never `createdAt`. Backfilled/migrated batches have a `createdAt` that lags real receiving date. Because using `createdAt` silently mis-costs COGS on any location that went through cutover.
- Don't add a hand-maintained architecture doc. Instead update the graphify graph. Because prose docs drift; the graph is regenerated from the AST.
- Don't commit files over 256 KB of source/data into a path Claude needs to read (e.g. `data/*.json`). Instead keep large datasets out of the read path or split them. Because Claude Code cannot open files that large.
