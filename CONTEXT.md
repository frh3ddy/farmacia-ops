# Farmacia System Context

> **Purpose**: This file provides complete system context for AI assistants (Genspark, Claude, etc.) when working on either the backend or iOS frontend. Read this file first to understand the full system architecture.

## System Overview

**Farmacia** is a multi-location pharmacy management system with Square POS integration. It provides:

- **FIFO Inventory Tracking**: First-In-First-Out cost calculation for accurate COGS
- **Square POS Integration**: Real-time sync of sales, inventory adjustments, and catalog
- **Comprehensive Reporting**: P&L, COGS, margins, inventory valuation
- **Multi-Location Support**: Manage multiple pharmacy locations from one system
- **Audit Trail**: Complete traceability for all inventory movements

## Repositories

| Repository | Purpose | Tech Stack |
|------------|---------|------------|
| [farmacia-ops](https://github.com/frh3ddy/farmacia-ops) | Backend API + Worker | NestJS, Prisma, PostgreSQL |
| [farmacia-ios](https://github.com/frh3ddy/farmacia-ios) | iOS App (planned) | Swift, SwiftUI |

---

## Implementation Status

### Completed Phases

| Phase | Description | Status |
|-------|-------------|--------|
| **A** | FIFO Foundation | ✅ Complete |
| A.1 | FIFO cost calculation in sale worker | ✅ |
| A.2 | Inventory deduction (oldest batches first) | ✅ |
| A.3 | Error handling for extraction | ✅ |
| **B** | Audit Trail (InventoryConsumption) | ✅ Complete |
| B.1 | InventoryConsumption model | ✅ |
| B.2 | FIFO audit records on sales | ✅ |
| B.3 | Reconciliation endpoints | ✅ |
| **C** | Inventory Adjustments | ✅ Complete |
| C.1 | InventoryAdjustment model | ✅ |
| C.2 | Negative adjustments (damage, theft, expired) | ✅ |
| C.3 | Positive adjustments (found, return) | ✅ |
| C.4 | Square sync (optional) | ✅ |
| **C.5** | Inventory Receiving | ✅ Complete |
| C.5.1 | InventoryReceiving model | ✅ |
| C.5.2 | New batch creation (source: PURCHASE) | ✅ |
| C.5.3 | Supplier cost tracking | ✅ |
| C.5.4 | Square sync for receiving | ✅ |
| **D** | Reporting | ✅ Complete |
| D.1 | COGS Report | ✅ |
| D.2 | Inventory Valuation | ✅ |
| D.3 | Profit Margin Report | ✅ |
| D.4 | Adjustment Impact Report | ✅ |
| D.5 | Receiving Summary Report | ✅ |
| D.6 | Dashboard (consolidated metrics) | ✅ |
| **E** | Operating Expenses & P&L | ✅ Complete |
| E.1 | Expense model (12 types) | ✅ |
| E.2 | Expense CRUD endpoints | ✅ |
| E.3 | Profit & Loss Report | ✅ |
| E.4 | Dashboard with net profit | ✅ |

### Current Phase (Pending)

| Phase | Description | Status |
|-------|-------------|--------|
| **F** | Multi-Location Authentication | 🔄 Planned |
| F.1 | Device model (activation flow) | ⏳ |
| F.2 | Employee model with PIN | ⏳ |
| F.3 | EmployeeLocationAssignment (roles per location) | ⏳ |
| F.4 | Device activation endpoint | ⏳ |
| F.5 | PIN login with session tokens | ⏳ |
| F.6 | Location switching | ⏳ |
| F.7 | Role-based guards | ⏳ |
| F.8 | Audit logging | ⏳ |

### Future Phases

| Phase | Description | Priority |
|-------|-------------|----------|
| **G** | Alerts & Thresholds | High |
| **H** | Supplier Performance Reports | Medium |
| **I** | Product Performance Reports | Medium |
| **J** | Export (CSV/Excel/PDF) | Medium |
| **K** | iOS App Development | High |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         iOS App                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  Auth/PIN   │  │  Inventory  │  │   Reports   │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       NestJS API                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │    Auth     │  │  Inventory  │  │   Reports   │              │
│  │  Controller │  │ Controllers │  │  Controller │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐              │
│  │    Auth     │  │  Inventory  │  │   Reports   │              │
│  │   Service   │  │  Services   │  │   Service   │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
└─────────┼────────────────┼────────────────┼─────────────────────┘
          │                │                │
          └────────────────┼────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Prisma ORM                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    PostgreSQL                            │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │    │
│  │  │ Location │ │ Product  │ │Inventory │ │   Sale   │   │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │    │
│  │  │ Employee │ │  Device  │ │ Expense  │ │ AuditLog │   │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                           │
                           │ Webhooks
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Worker Service                               │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Square Webhook Processor                    │    │
│  │  • Process sales → FIFO deduction → Audit trail         │    │
│  │  • Sync inventory changes to Square                      │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Square POS                                 │
│  • Catalog (products, variations)                                │
│  • Inventory counts                                              │
│  • Sales transactions                                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Concepts

### FIFO (First-In-First-Out)

Inventory is tracked in **batches** with individual costs. When selling:
1. System finds oldest batch with available quantity
2. Deducts from that batch first
3. Creates consumption record for audit trail
4. Moves to next oldest batch if needed

```
Example:
  Batch 1: 10 units @ $5.00 (receivedAt: Jan 1)
  Batch 2: 20 units @ $6.00 (receivedAt: Jan 15)
  
  Sale: 15 units
  → Consume 10 from Batch 1 (cost: $50)
  → Consume 5 from Batch 2 (cost: $30)
  → Total COGS: $80
```

### Inventory Sources

| Source | Description | Created By |
|--------|-------------|------------|
| `OPENING_BALANCE` | Initial inventory from cutover migration | Migration |
| `PURCHASE` | New stock received from supplier | `/inventory/receive` |
| `ADJUSTMENT` | Found items, returns (positive adjustments) | `/inventory/adjustments` |

### Adjustment Types

| Type | Direction | Description |
|------|-----------|-------------|
| `DAMAGE` | Negative | Product damaged, unsellable |
| `THEFT` | Negative | Product stolen/missing |
| `EXPIRED` | Negative | Product past expiration |
| `WRITE_OFF` | Negative | General write-off |
| `TRANSFER_OUT` | Negative | Transferred to another location |
| `FOUND` | Positive | Product found |
| `RETURN` | Positive | Customer return |
| `TRANSFER_IN` | Positive | Received from another location |
| `COUNT_CORRECTION` | Variable | Physical count adjustment |
| `OTHER` | Variable | Other (requires notes) |

### Expense Types

| Type | Description |
|------|-------------|
| `RENT` | Monthly rent |
| `UTILITIES` | Electric, water, gas |
| `PAYROLL` | Employee wages |
| `INSURANCE` | Business insurance |
| `SUPPLIES` | Office/store supplies (not inventory) |
| `MARKETING` | Advertising, promotions |
| `MAINTENANCE` | Repairs, upkeep |
| `TAXES` | Business taxes |
| `BANK_FEES` | Banking charges |
| `SOFTWARE` | POS software, subscriptions |
| `PROFESSIONAL` | Accountant, lawyer fees |
| `OTHER` | Miscellaneous |

---

## Authentication Architecture (Planned - Phase F)

### Multi-User PIN Access Model

```
┌─────────────────────────────────────────────────────────────┐
│                     iPad at Store                            │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Device Token (long-lived, tied to location)         │    │
│  │  → Activated once by Owner/Manager                   │    │
│  └─────────────────────────────────────────────────────┘    │
│                           │                                  │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Employee PIN Login (fast switching)                 │    │
│  │  → 4-6 digit PIN per employee                        │    │
│  │  → Returns session token                             │    │
│  │  → Role-based permissions                            │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Roles & Permissions

| Role | Employees | Inventory | Expenses | Reports | Settings |
|------|-----------|-----------|----------|---------|----------|
| OWNER | Full CRUD | Full CRUD | Full CRUD | All | Full |
| MANAGER | Read | Adjust/Receive | Create/Read/Update | All | Read |
| CASHIER | - | Read | - | - | - |
| ACCOUNTANT | - | Read | Full CRUD | All | - |

---

## File Structure

```
farmacia-ops/
├── CONTEXT.md                    # This file - system context
├── API_CONTRACTS.md              # API endpoint specifications
├── docs/
│   ├── AUTHENTICATION.md         # Auth system design
│   ├── DATA_MODELS.md            # Entity relationships
│   └── testing-inventory-consumption.md
├── apps/
│   ├── api/                      # NestJS API
│   │   └── src/
│   │       ├── inventory/
│   │       │   ├── inventory-adjustment.controller.ts
│   │       │   ├── inventory-adjustment.service.ts
│   │       │   ├── inventory-receiving.controller.ts
│   │       │   ├── inventory-receiving.service.ts
│   │       │   ├── inventory-reconciliation.controller.ts
│   │       │   ├── inventory-reconciliation.service.ts
│   │       │   ├── inventory-reports.controller.ts
│   │       │   ├── inventory-reports.service.ts
│   │       │   ├── expense.controller.ts
│   │       │   ├── expense.service.ts
│   │       │   └── inventory.module.ts
│   │       └── app.module.ts
│   └── worker/                   # Square webhook processor
│       └── src/
│           └── sale.worker.ts    # FIFO processing
├── prisma/
│   ├── schema.prisma             # Database schema
│   └── migrations/               # Database migrations
└── scripts/
    └── test-inventory-adjustments.ts
```

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `SQUARE_ACCESS_TOKEN` | Square API access token | Yes (for sync) |
| `SQUARE_ENVIRONMENT` | `sandbox` or `production` | Yes |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Webhook verification | Yes |

---

## Quick Reference

### API Base URL
- **Production**: `https://farmacia-api.railway.app`
- **Local**: `http://localhost:3000`

### Key Endpoints (Summary)

| Category | Endpoint | Description |
|----------|----------|-------------|
| Receiving | `POST /inventory/receive` | Receive new stock |
| Adjustments | `POST /inventory/adjustments` | Create adjustment |
| Adjustments | `POST /inventory/adjustments/damage` | Quick damage adjustment |
| Adjustments | `POST /inventory/adjustments/found` | Quick found adjustment |
| Reports | `GET /inventory/reports/cogs` | COGS report |
| Reports | `GET /inventory/reports/valuation` | Inventory valuation |
| Reports | `GET /inventory/reports/profit-loss` | P&L statement |
| Reports | `GET /inventory/reports/dashboard` | All metrics |
| Expenses | `POST /expenses` | Create expense |
| Expenses | `GET /expenses/summary/report` | Expense summary |
| Reconciliation | `GET /inventory/reconciliation/location/:id` | Location reconciliation |

> See `API_CONTRACTS.md` for complete endpoint documentation.

---

## For AI Assistants

### When Working on Backend

```
Context: farmacia-ops (NestJS backend)
Repository: https://github.com/frh3ddy/farmacia-ops
Tech Stack: NestJS, Prisma, PostgreSQL, TypeScript

Key Files:
- prisma/schema.prisma (database models)
- apps/api/src/inventory/*.ts (inventory services)
- apps/worker/src/sale.worker.ts (FIFO processing)

Current Phase: F (Authentication)
```

### When Working on iOS

```
Context: farmacia-ios (SwiftUI app)
Repository: https://github.com/frh3ddy/farmacia-ios
Tech Stack: Swift, SwiftUI, Combine

Backend API: https://github.com/frh3ddy/farmacia-ops
API Contracts: See API_CONTRACTS.md

Current Phase: Initial scaffold with auth flow
```

---

## Related Documents

- **API_CONTRACTS.md**: Complete API endpoint specifications
- **docs/AUTHENTICATION.md**: Detailed auth system design
- **docs/DATA_MODELS.md**: Database entity relationships
- **docs/testing-inventory-consumption.md**: Testing guide

---

*Last Updated: 2026-01-30*
*Version: 1.0*
