# Farmacia Data Models

> **Database Entity Relationships and Schema Reference**

## Entity Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CORE ENTITIES                                   │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│   Location   │───┬───│   Product    │───────│   Category   │
└──────────────┘   │   └──────────────┘       └──────────────┘
       │           │          │
       │           │          │
       ▼           │          ▼
┌──────────────┐   │   ┌──────────────┐       ┌──────────────┐
│  Inventory   │◀──┴───│SupplierProduct│──────│   Supplier   │
│   (Batch)    │       └──────────────┘       └──────────────┘
└──────────────┘              │
       │                      │
       │                      ▼
       │               ┌──────────────────┐
       │               │SupplierCostHistory│
       │               └──────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           FIFO & AUDIT TRAIL                                  │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐       ┌──────────────────────┐       ┌──────────────┐
│  Inventory   │◀──────│ InventoryConsumption │──────▶│   SaleItem   │
│   (Batch)    │       │   (FIFO Audit)       │       └──────────────┘
└──────────────┘       └──────────────────────┘              │
       ▲                        │                            │
       │                        │                            ▼
       │                        ▼                      ┌──────────────┐
       │               ┌──────────────────────┐       │     Sale     │
       │               │  InventoryAdjustment │       └──────────────┘
       │               └──────────────────────┘
       │                        │
       │                        ▼
┌──────────────────────┐
│  InventoryReceiving  │
└──────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                              FINANCIALS                                       │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐
│   Location   │
└──────────────┘
       │
       ├──────────────▶ ┌──────────────┐
       │                │   Expense    │
       │                └──────────────┘
       │
       └──────────────▶ ┌──────────────┐
                        │     Sale     │
                        └──────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                        AUTHENTICATION (Phase F)                               │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐       ┌──────────────┐       ┌──────────────────────────────┐
│   Location   │◀──────│    Device    │       │         Employee             │
└──────────────┘       └──────────────┘       └──────────────────────────────┘
       │                                                     │
       │                                                     │
       └──────────────────┐                ┌─────────────────┘
                          │                │
                          ▼                ▼
                   ┌─────────────────────────────────┐
                   │  EmployeeLocationAssignment     │
                   │  (Role per Location)            │
                   └─────────────────────────────────┘
                                   │
                                   ▼
                          ┌──────────────┐
                          │   AuditLog   │
                          └──────────────┘
```

---

## Core Models

### Location

Represents a physical pharmacy location.

```prisma
model Location {
  id       String  @id @default(uuid())
  squareId String? @unique    // Square location ID for sync
  name     String             // "Main Pharmacy"
  address  String?
  isActive Boolean @default(true)

  // Relations
  inventories     Inventory[]
  expenses        Expense[]
  sales           Sale[]
  adjustments     InventoryAdjustment[]
  receivings      InventoryReceiving[]
  catalogMappings CatalogMapping[]
  cutoverLocks    CutoverLock[]
  racks           Rack[]
  
  // Future: Auth relations
  // devices     Device[]
  // assignments EmployeeLocationAssignment[]

  createdAt DateTime @default(now())
}
```

**Key Points:**
- `squareId` links to Square POS location
- All inventory, sales, expenses are location-scoped
- `isActive` allows soft-delete of locations

---

### Product

Represents a sellable item (medication, supply).

```prisma
model Product {
  id         String  @id @default(uuid())
  name       String             // "Aspirin 100mg Tablet"
  sku        String? @unique    // Internal SKU
  categoryId String?

  // Cached Square catalog data
  squareProductName   String?   // Name from Square ITEM
  squareDescription   String?   // Description from Square
  squareImageUrl      String?   // Product image URL
  squareVariationName String?   // Variation name
  squareDataSyncedAt  DateTime?

  // Relations
  category            Category?
  suppliers           SupplierProduct[]
  supplierCostHistory SupplierCostHistory[]
  inventories         Inventory[]
  saleItems           SaleItem[]
  catalogMappings     CatalogMapping[]
  adjustments         InventoryAdjustment[]
  receivings          InventoryReceiving[]
  costApprovals       CostApproval[]
  placements          Placement[]

  createdAt DateTime @default(now())
}
```

**Key Points:**
- Links to Square via `CatalogMapping`
- Has multiple inventory batches (FIFO)
- Can have multiple suppliers with different costs

---

### Inventory (FIFO Batch)

A batch of inventory with specific cost and age.

```prisma
model Inventory {
  id         String @id @default(uuid())
  locationId String
  productId  String

  quantity    Int            // Current quantity in batch
  receivedAt  DateTime       // When batch was received (FIFO ordering)
  unitCost    Decimal        // Cost per unit
  source      String?        // "OPENING_BALANCE", "PURCHASE", "ADJUSTMENT"
  costSource  String?        // "SQUARE_COST", "DESCRIPTION", "MANUAL_INPUT"
  migrationId String?        // Reference to cutover migration

  // Relations
  location Location @relation(fields: [locationId], references: [id])
  product  Product  @relation(fields: [productId], references: [id])

  // Audit trail
  consumptions InventoryConsumption[]

  // Created by
  createdByAdjustment InventoryAdjustment? @relation("AdjustmentCreatedBatch")
  createdByReceiving  InventoryReceiving?  @relation("ReceivingCreatedBatch")

  createdAt DateTime @default(now())

  @@index([productId])
  @@index([locationId])
  @@index([source])
  @@index([receivedAt])  // Critical for FIFO ordering
}
```

**Key Points:**
- `receivedAt` determines FIFO order (oldest first)
- `source` identifies how batch was created
- Multiple batches per product/location (no unique constraint)
- Each batch consumed independently for accurate COGS

---

### InventoryConsumption (FIFO Audit Trail)

Records which batches were consumed for each sale/adjustment.

```prisma
model InventoryConsumption {
  id String @id @default(uuid())

  inventoryId  String         // Batch consumed
  saleItemId   String?        // If consumed by sale
  adjustmentId String?        // If consumed by adjustment

  quantity  Int               // Quantity from this batch
  unitCost  Decimal           // Cost at consumption time
  totalCost Decimal           // quantity * unitCost

  consumedAt DateTime @default(now())

  // Relations
  inventory  Inventory            @relation(...)
  saleItem   SaleItem?            @relation(...)
  adjustment InventoryAdjustment? @relation(...)

  @@index([inventoryId])
  @@index([saleItemId])
  @@index([adjustmentId])
  @@index([consumedAt])
}
```

**Key Points:**
- **APPEND-ONLY**: Never modified after creation
- **IMMUTABLE**: For audit integrity
- Links sale items to specific batches for COGS accuracy
- Enables full traceability of inventory movements

---

### InventoryAdjustment

Records inventory changes outside of sales.

```prisma
model InventoryAdjustment {
  id         String @id @default(uuid())
  locationId String
  productId  String

  type          AdjustmentType
  quantity      Int            // Positive = add, Negative = remove
  reason        String?
  notes         String?

  unitCost      Decimal        // Cost per unit
  totalCost     Decimal        // |quantity| * unitCost

  // For positive adjustments
  createdBatchId String? @unique

  // Audit
  adjustedAt    DateTime @default(now())
  adjustedBy    String?
  effectiveDate DateTime @default(now())

  // Relations
  location     Location   @relation(...)
  product      Product    @relation(...)
  createdBatch Inventory? @relation("AdjustmentCreatedBatch", ...)
  consumptions InventoryConsumption[]

  @@index([locationId])
  @@index([productId])
  @@index([type])
  @@index([adjustedAt])
}

enum AdjustmentType {
  DAMAGE
  THEFT
  EXPIRED
  COUNT_CORRECTION
  FOUND
  RETURN
  TRANSFER_OUT
  TRANSFER_IN
  WRITE_OFF
  OTHER
}
```

**Key Points:**
- Negative adjustments consume FIFO batches (create consumption records)
- Positive adjustments create new inventory batches
- `effectiveDate` allows backdating for reconciliation
- Includes Square sync status

---

### InventoryReceiving

Records new inventory received from suppliers.

```prisma
model InventoryReceiving {
  id         String @id @default(uuid())
  locationId String
  productId  String
  supplierId String?

  quantity      Int
  unitCost      Decimal
  totalCost     Decimal

  // Reference numbers
  invoiceNumber     String?
  purchaseOrderId   String?
  batchNumber       String?

  // Product tracking
  expiryDate        DateTime?
  manufacturingDate DateTime?

  // Created batch
  inventoryBatchId String @unique

  // Square sync
  squareSynced    Boolean   @default(false)
  squareSyncedAt  DateTime?
  squareSyncError String?

  // Audit
  receivedAt DateTime @default(now())
  receivedBy String?
  notes      String?

  // Relations
  location       Location  @relation(...)
  product        Product   @relation(...)
  supplier       Supplier? @relation(...)
  inventoryBatch Inventory @relation("ReceivingCreatedBatch", ...)

  @@index([locationId])
  @@index([productId])
  @@index([supplierId])
  @@index([receivedAt])
  @@index([invoiceNumber])
}
```

**Key Points:**
- Always creates new inventory batch (source: "PURCHASE")
- Tracks supplier, invoice, batch numbers
- Supports Square sync for inventory counts
- `expiryDate` for pharmaceutical compliance

---

## Sales Models

### Sale

A completed sales transaction.

```prisma
model Sale {
  id         String @id @default(uuid())
  squareId   String @unique    // Square transaction ID
  locationId String

  totalRevenue Decimal         // Sum of item prices
  totalCost    Decimal         // Sum of FIFO costs
  grossProfit  Decimal         // revenue - cost

  createdAt DateTime           // Transaction time

  // Relations
  items    SaleItem[]
  location Location @relation(...)
}
```

### SaleItem

A line item in a sale.

```prisma
model SaleItem {
  id        String @id @default(uuid())
  saleId    String
  productId String

  quantity Int
  price    Decimal              // Selling price
  cost     Decimal              // FIFO cost (calculated)

  // Relations
  sale         Sale       @relation(...)
  product      Product    @relation(...)
  consumptions InventoryConsumption[]
}
```

**Key Points:**
- `cost` is calculated using FIFO at sale time
- `consumptions` link to specific batches used
- Created by worker processing Square webhooks

---

## Financial Models

### Expense

Operating expense records.

```prisma
model Expense {
  id         String @id @default(uuid())
  locationId String

  type        ExpenseType
  amount      Decimal
  date        DateTime
  description String?
  vendor      String?
  reference   String?
  isPaid      Boolean   @default(true)
  paidAt      DateTime?
  notes       String?
  createdBy   String?
  createdAt   DateTime  @default(now())

  location Location @relation(...)

  @@index([locationId])
  @@index([type])
  @@index([date])
}

enum ExpenseType {
  RENT
  UTILITIES
  PAYROLL
  INSURANCE
  SUPPLIES
  MARKETING
  MAINTENANCE
  TAXES
  BANK_FEES
  SOFTWARE
  PROFESSIONAL
  OTHER
}
```

**Key Points:**
- Location-scoped for multi-location P&L
- 12 expense types for detailed categorization
- Tracks payment status for cash flow

---

## Square Integration

### CatalogMapping

Links products to Square catalog variations.

```prisma
model CatalogMapping {
  id                String  @id @default(uuid())
  squareVariationId String  // ITEM_VARIATION.id
  productId         String
  locationId        String?

  // Cached selling price
  priceCents    Decimal?
  currency      String?
  priceSyncedAt DateTime?

  product  Product  @relation(...)
  location Location? @relation(...)

  syncedAt  DateTime @default(now())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([squareVariationId, locationId])
  @@index([productId])
  @@index([squareVariationId])
}
```

**Key Points:**
- One product can have multiple variations
- Variation prices can differ by location
- Required for inventory sync to Square

---

## Supplier Models

### Supplier

```prisma
model Supplier {
  id             String   @id @default(uuid())
  name           String
  normalizedName String   @unique    // For matching
  initials       String[] @default([])  // ["L", "Lev"] for cost extraction
  contactInfo    String?
  isActive       Boolean  @default(true)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  products    SupplierProduct[]
  costHistory SupplierCostHistory[]
  receivings  InventoryReceiving[]
}
```

### SupplierProduct

Links suppliers to products with preferred pricing.

```prisma
model SupplierProduct {
  id         String @id @default(uuid())
  supplierId String
  productId  String

  cost        Decimal
  isPreferred Boolean @default(false)
  notes       String?

  supplier Supplier @relation(...)
  product  Product  @relation(...)

  @@unique([supplierId, productId])
}
```

### SupplierCostHistory

Tracks cost changes over time.

```prisma
model SupplierCostHistory {
  id          String   @id @default(uuid())
  productId   String
  supplierId  String
  unitCost    Decimal
  effectiveAt DateTime
  source      String   // "MIGRATION", "INVENTORY_UPDATE", "MANUAL"
  isCurrent   Boolean  @default(true)
  createdAt   DateTime @default(now())

  product  Product  @relation(...)
  supplier Supplier @relation(...)

  @@index([productId, supplierId])
  @@index([isCurrent])
}
```

---

## Migration Models

### Cutover

Tracks inventory migration from Square.

```prisma
model Cutover {
  id              String    @id @default(uuid())
  cutoverDate     DateTime
  costBasis       String
  ownerApproved   Boolean
  ownerApprovedAt DateTime?
  ownerApprovedBy String?
  completedAt     DateTime?
  status          String    // "PENDING", "COMPLETED", "FAILED", "IN_PROGRESS"
  result          Json?
  batchSize       Int?
  currentBatch    Int?
  totalBatches    Int?
  processedItems  Int?
  totalItems      Int?
  batchState      Json?
  createdAt       DateTime  @default(now())
}
```

### CutoverLock

Prevents double-processing during migration.

```prisma
model CutoverLock {
  id          String   @id @default(uuid())
  locationId  String?
  cutoverDate DateTime
  isLocked    Boolean  @default(true)
  lockedAt    DateTime @default(now())
  lockedBy    String?

  location Location? @relation(...)

  @@unique([locationId, cutoverDate])
}
```

### ExtractionSession / ExtractionBatch

Manages cost extraction workflow.

```prisma
model ExtractionSession {
  id          String   @id @default(uuid())
  cutoverId   String?
  locationIds String[]

  currentBatch   Int  @default(1)
  totalBatches   Int?
  totalItems     Int
  processedItems Int  @default(0)
  batchSize      Int

  lastApprovedBatchId   String?
  lastApprovedProductId String?
  learnedSupplierInitials Json?

  status String @default("IN_PROGRESS")

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  batches ExtractionBatch[]
}

model ExtractionBatch {
  id                  String   @id @default(uuid())
  extractionSessionId String
  batchNumber         Int
  cutoverId           String?
  locationIds         String[]

  status      String    @default("EXTRACTED")
  extractedAt DateTime  @default(now())
  approvedAt  DateTime?
  approvedBy  String?

  productIds                   String[]
  totalProducts                Int
  productsWithExtraction       Int
  productsRequiringManualInput Int

  extractionApproved  Boolean @default(false)
  manualInputApproved Boolean @default(false)
  isFullyApproved     Boolean @default(false)

  lastApprovedProductId String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  session   ExtractionSession @relation(...)
  approvals CostApproval[]
}

model CostApproval {
  id              String          @id @default(uuid())
  cutoverId       String
  batchId         String?
  productId       String
  approvedCost    Decimal
  source          String
  notes           String?
  approvedAt      DateTime        @default(now())
  approvedBy      String?
  migrationStatus MigrationStatus @default(PENDING)

  sellingPriceCents         Int?
  sellingPriceCurrency      String?
  sellingPriceRangeMinCents Int?
  sellingPriceRangeMaxCents Int?

  product Product          @relation(...)
  batch   ExtractionBatch? @relation(...)

  @@unique([cutoverId, productId])
}

enum MigrationStatus {
  PENDING
  APPROVED
  SKIPPED
}
```

---

## Physical Layout Models

### Rack / RackSection / Placement

For physical inventory location tracking.

```prisma
model Rack {
  id         String @id @default(uuid())
  locationId String
  name       String

  sections RackSection[]
  location Location @relation(...)
}

model RackSection {
  id     String @id @default(uuid())
  rackId String
  label  String
  size   String

  placements Placement[]
  rack       Rack @relation(...)
}

model Placement {
  id            String @id @default(uuid())
  productId     String
  rackSectionId String

  product Product     @relation(...)
  section RackSection @relation(...)
}
```

---

## Authentication Models (Phase F - Planned)

### Device

```prisma
model Device {
  id            String    @id @default(uuid())
  locationId    String
  name          String
  deviceToken   String    @unique
  isActive      Boolean   @default(true)
  lastActiveAt  DateTime?
  activatedAt   DateTime  @default(now())
  activatedBy   String

  location Location @relation(...)

  @@index([deviceToken])
  @@index([locationId])
}
```

### Employee

```prisma
model Employee {
  id           String    @id @default(uuid())
  name         String
  email        String?   @unique
  passwordHash String?
  pin          String?
  pinSalt      String?
  isActive     Boolean   @default(true)
  lastLoginAt  DateTime?
  createdAt    DateTime  @default(now())
  createdBy    String?

  assignments EmployeeLocationAssignment[]
  auditLogs   AuditLog[]
}
```

### EmployeeLocationAssignment

```prisma
model EmployeeLocationAssignment {
  id         String       @id @default(uuid())
  employeeId String
  locationId String
  role       EmployeeRole
  isActive   Boolean      @default(true)
  assignedAt DateTime     @default(now())
  assignedBy String?

  employee Employee @relation(...)
  location Location @relation(...)

  @@unique([employeeId, locationId])
}

enum EmployeeRole {
  OWNER
  MANAGER
  CASHIER
  ACCOUNTANT
}
```

### AuditLog

```prisma
model AuditLog {
  id         String   @id @default(uuid())
  employeeId String?
  deviceId   String?
  locationId String?
  action     String
  entityType String?
  entityId   String?
  details    Json?
  ipAddress  String?
  timestamp  DateTime @default(now())

  employee Employee? @relation(...)

  @@index([employeeId])
  @@index([timestamp])
  @@index([entityType, entityId])
}
```

---

## Data Flow Examples

### Sale Processing (FIFO)

```
Square Webhook (order.created)
         │
         ▼
    Sale Worker
         │
         ├─── Create Sale record
         │
         ├─── For each line item:
         │         │
         │         ├─── Find oldest Inventory batches (FIFO)
         │         │
         │         ├─── Deduct from batches
         │         │
         │         ├─── Create InventoryConsumption records
         │         │
         │         └─── Calculate cost for SaleItem
         │
         └─── Update Sale totals (totalCost, grossProfit)
```

### Inventory Receiving

```
POST /inventory/receive
         │
         ▼
  Validate inputs
         │
         ├─── Create Inventory batch (source: PURCHASE)
         │
         ├─── Create InventoryReceiving record
         │
         ├─── If syncToSquare: Push to Square API
         │
         └─── Return receiving + batch details
```

### Negative Adjustment (FIFO)

```
POST /inventory/adjustments (type: DAMAGE, quantity: -5)
         │
         ▼
  Validate inputs
         │
         ├─── Find oldest Inventory batches (FIFO)
         │
         ├─── Deduct from batches
         │
         ├─── Create InventoryConsumption records
         │
         ├─── Create InventoryAdjustment record
         │
         ├─── If syncToSquare: Push to Square API
         │
         └─── Return adjustment + consumption details
```

---

## Indexes Strategy

| Model | Index | Purpose |
|-------|-------|---------|
| Inventory | `receivedAt` | FIFO ordering |
| Inventory | `productId` | Batch lookup |
| Inventory | `locationId` | Location filtering |
| InventoryConsumption | `saleItemId` | Audit trail lookup |
| InventoryConsumption | `adjustmentId` | Audit trail lookup |
| InventoryAdjustment | `adjustedAt` | Date filtering |
| InventoryAdjustment | `type` | Type filtering |
| InventoryReceiving | `receivedAt` | Date filtering |
| InventoryReceiving | `invoiceNumber` | Invoice lookup |
| Expense | `date` | Date filtering |
| Expense | `type` | Type filtering |
| Sale | `squareId` | Webhook idempotency |

---

*Last Updated: 2026-01-30*
*Version: 1.0*
