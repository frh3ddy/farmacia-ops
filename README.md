# Farmacia Ops

Backend and back-office tooling for a multi-location pharmacy operation running on Square POS. Tracks inventory with FIFO costing, syncs sales/catalog/inventory from Square in real time, and reports COGS, gross margin, inventory valuation, and P&L per location.

## Architecture

| App | Path | What it does |
|---|---|---|
| **API** | `apps/api` | NestJS REST API — auth (device + PIN sessions), locations, products, suppliers, inventory, expenses, reports, Square webhooks, and the historical-cost cutover/migration pipeline. Serves `apps/web`'s build output as static files. |
| **Worker** | `apps/worker` | BullMQ background worker — processes Square sale webhooks into FIFO-costed `Sale`/`SaleItem`/inventory-consumption records. |
| **Web** | `apps/web` | The back-office tool suite (Vite + React 19 + TypeScript): Ops (locations/products/suppliers/catalog), Cutover (the inventory-migration wizard), Reports (inventory aging, growing into a full dashboard), and Dev Tools (webhook/sales testing). Builds directly into `apps/api/public`; the API serves it at `/` with no separate frontend deploy. |

**Data layer:** PostgreSQL via Prisma (`prisma/schema.prisma`, one shared schema for both API and worker), Redis for the BullMQ queue.

**Square integration:** the worker consumes `payment.created` webhooks; the API syncs the Square catalog (products/pricing) and locations. FIFO consumption order is `Inventory.receivedAt ASC` — never `createdAt` — since backfilled/migrated batches can have a `createdAt` that lags the real receiving date.

See `CONTEXT.md` for the full domain model and `API_CONTRACTS.md` for endpoint-level request/response contracts (written primarily for the iOS app, still accurate for the API in general).

## Development setup

### Prerequisites

- Node 20+, npm
- Docker (for local Postgres + Redis)

### 1. Install dependencies

```bash
npm install
```

This also runs `prisma generate` via `postinstall`.

### 2. Environment variables

Create a `.env` in the repo root:

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/farmacia_db

# Redis (BullMQ) — REDIS_URL is enough locally; REDISHOST/REDISPORT are
# Railway's Redis plugin convention, used in production
REDIS_URL=redis://localhost:6379

# Square API
SQUARE_ACCESS_TOKEN=
SQUARE_ENVIRONMENT=sandbox   # or production
SQUARE_SIGNATURE_KEY=
SQUARE_WEBHOOK_URL=
SQUARE_WEBHOOK_NOTIFICATION_URL=
```

### 3. Start Postgres + Redis

```bash
npm run db:up      # docker compose up -d
```

### 4. Run migrations

```bash
npm run prisma:migrate:dev
```

### 5. Seed a test owner (optional)

`scripts/seed-owner.ts` creates a throwaway OWNER account, a CASHIER account, and a "Main Pharmacy" location — safe to run against a local dev database (upserts on fixed IDs):

```bash
npx ts-node scripts/seed-owner.ts
```

Prints the login credentials it created (device-activation email/password, PIN for both accounts).

### 6. Run it

**API + worker (hot reload):**

```bash
npm run dev:api      # NestJS on :3000
npm run dev:worker   # BullMQ worker, separate terminal
```

**Web app (hot reload):** in another terminal —

```bash
npm run dev:web      # Vite on :5173, proxies API calls to :3000
```

Open **http://localhost:5173/**. Login is device-activation-then-PIN: enter an email/password to activate the browser as a device, then a PIN to start a session (see `apps/api/src/auth`).

**Or, closest to how it runs in production** — a single built API process serving the web app itself:

```bash
npm run build        # builds worker, api, and web (web lands in apps/api/public)
npm run start:api
```

Open **http://localhost:3000/**.

### Useful scripts

| Script | What it does |
|---|---|
| `npm run build` | Builds worker, api, and web, in that order |
| `npm run dev:api` / `dev:worker` / `dev:web` | Hot-reload dev servers |
| `npm run db:up` / `db:down` | Local Postgres + Redis via Docker Compose |
| `npm run prisma:migrate:dev` | Create/apply a migration locally |
| `npm run prisma:migrate:create` | Create a migration without applying it (`scripts/create-migration.sh`) |
| `npm run prisma:studio` | Prisma Studio (DB browser) |

## Railway deployment

The API and worker deploy as two Railway services against this same repo, plus Railway's managed Postgres and Redis plugins (their env vars — `DATABASE_URL`, `REDISHOST`/`REDISPORT`/`REDIS_URL` — are auto-injected, not set by hand).

- **Build** (`nixpacks.toml`, shared by both services): `npm install` → `npm run prisma:generate` → `npm run build`.
- **Start commands** (set per-service in the Railway dashboard, not in-repo): `npm run start:api` for the API service, `npm run start:worker` for the worker service.
- **Migrations run automatically on API boot**, before the server starts listening (see the `bootstrap()` function in `apps/api/src/main.ts`) — `DATABASE_URL` needs to be available at that point, which is why migrations aren't a separate build-phase step.
- The API serves `apps/web`'s build output directly (`apps/api/public`, generated by `npm run build`, not committed) — no separate frontend service or domain to configure.
- Required env vars beyond the Railway-injected `DATABASE_URL`/Redis vars: `SQUARE_ACCESS_TOKEN`, `SQUARE_ENVIRONMENT`, `SQUARE_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL`, `SQUARE_WEBHOOK_NOTIFICATION_URL`.
