# farmacia-ops

Backend + back-office tooling for a multi-location pharmacy running on Square POS.
npm workspaces monorepo: `apps/api` (NestJS REST + serves the web build), `apps/worker`
(BullMQ — turns Square `payment.created` webhooks into FIFO-costed sales/inventory
records), `apps/web` (Vite + React 19 back-office suite, builds into `apps/api/public`).
Data: PostgreSQL via Prisma (`prisma/schema.prisma`, shared by api + worker), Redis for the queue.

> Global rules live in `~/dev/CLAUDE.md` and `~/CLAUDE.md`. This file is project-specific only.

## AIDD framework

@AGENTS.md
@aidd-custom/AGENTS.md

`ai/` is the AIDD framework (`npx aidd`). Its commands are linked into `.claude/commands/`
as `/aidd-discover`, `/aidd-plan`, `/aidd-task`, `/aidd-execute`, `/aidd-commit`,
`/aidd-user-test`, `/aidd-run-test`, `/aidd-help` (prefixed so they don't shadow built-ins
like `/review`); its skills are linked into `.claude/skills/` (`/aidd-review`, `/aidd-tdd`,
`/aidd-fix`, `/aidd-churn`, `/aidd-log`, …). Skills for stacks this repo doesn't use are
left unlinked: aidd-stack, aidd-autodux, aidd-lit, aidd-ecs, aidd-observe,
aidd-javascript-io-effects, aidd-error-causes, aidd-timing-safe-compare. After
`npx aidd --force` adds new files, link the new ones too. Regenerate `ai/**/index.md`
with `npx aidd --index` (no pre-commit hook is installed).

## Session checklist — if working on X, read Y

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

- Don't order FIFO consumption by `Inventory.createdAt`. Instead order by `receivedAt ASC`.
  Because: backfilled/migrated batches have a `createdAt` that lags the real receiving date, so `createdAt` silently mis-costs COGS on any location that went through cutover.
- Don't add a hand-maintained architecture doc. Instead update the graphify graph (`graphify update .`).
  Because: prose docs drift; the graph is regenerated from the AST.
- Don't commit files over 256 KB into a path Claude reads (e.g. `data/*.json`). Instead keep large datasets out of the read path or split them.
  Because: Claude Code cannot open files that large.
  Exception: `package-lock.json` is committed despite its size — builds need it, nobody needs to read it.
