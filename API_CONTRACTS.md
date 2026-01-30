# Farmacia API Contracts

> **Purpose**: Complete API endpoint specifications for frontend development. This document defines all request/response contracts for the iOS app.

## Base URL

| Environment | URL |
|-------------|-----|
| Production | `https://farmacia-api.railway.app` |
| Local | `http://localhost:3000` |

## Authentication (Planned - Phase F)

> **Note**: Authentication is not yet implemented. All endpoints are currently open.

### Future Auth Headers

```
Authorization: Bearer <device_token>
X-Session-Token: <session_token>
X-Location-Id: <location_id>
```

---

## Response Format

All endpoints return a consistent response format:

### Success Response
```json
{
  "success": true,
  "message": "Operation completed",
  "data": { ... },
  "count": 10  // Optional, for list endpoints
}
```

### Error Response
```json
{
  "success": false,
  "message": "Error description"
}
```

---

## Inventory Receiving

### POST /inventory/receive

Receive new inventory from a supplier. Creates a new FIFO batch.

**Request Body:**
```json
{
  "locationId": "string (required)",
  "productId": "string (required)",
  "quantity": "number (required, > 0)",
  "unitCost": "number (required, >= 0)",
  "supplierId": "string (optional)",
  "invoiceNumber": "string (optional)",
  "purchaseOrderId": "string (optional)",
  "batchNumber": "string (optional)",
  "expiryDate": "ISO 8601 date (optional)",
  "manufacturingDate": "ISO 8601 date (optional)",
  "receivedBy": "string (optional)",
  "notes": "string (optional)",
  "syncToSquare": "boolean (optional, default: false)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Received 100 units successfully (synced to Square)",
  "data": {
    "id": "uuid",
    "locationId": "string",
    "productId": "string",
    "supplierId": "string | null",
    "quantity": 100,
    "unitCost": "10.50",
    "totalCost": "1050.00",
    "invoiceNumber": "INV-001",
    "purchaseOrderId": "PO-001",
    "batchNumber": "BATCH-001",
    "expiryDate": "2027-01-30T00:00:00.000Z",
    "manufacturingDate": "2026-01-30T00:00:00.000Z",
    "inventoryBatchId": "uuid",
    "squareSynced": true,
    "squareSyncedAt": "2026-01-30T18:00:00.000Z",
    "squareSyncError": null,
    "receivedAt": "2026-01-30T18:00:00.000Z",
    "receivedBy": "user-id",
    "notes": "Delivery from main supplier",
    "location": { "id": "...", "name": "Main Store" },
    "product": { "id": "...", "name": "Aspirin 100mg" },
    "supplier": { "id": "...", "name": "PharmaCorp" },
    "squareSync": {
      "synced": true,
      "syncedAt": "2026-01-30T18:00:00.000Z",
      "error": null
    }
  }
}
```

### GET /inventory/receive/:id

Get a specific receiving record.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "locationId": "string",
    "productId": "string",
    "quantity": 100,
    "unitCost": "10.50",
    "totalCost": "1050.00",
    "invoiceNumber": "INV-001",
    "receivedAt": "2026-01-30T18:00:00.000Z",
    "inventoryBatch": {
      "id": "uuid",
      "quantity": 95,
      "unitCost": "10.50",
      "receivedAt": "2026-01-30T18:00:00.000Z"
    },
    "location": { ... },
    "product": { ... },
    "supplier": { ... }
  }
}
```

### GET /inventory/receive/location/:locationId

List receivings for a location.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `startDate` | ISO 8601 | Filter by start date |
| `endDate` | ISO 8601 | Filter by end date |
| `supplierId` | string | Filter by supplier |
| `productId` | string | Filter by product |
| `limit` | number | Max results (default: 100) |

**Response:**
```json
{
  "success": true,
  "count": 25,
  "data": [
    {
      "id": "uuid",
      "quantity": 100,
      "unitCost": "10.50",
      "totalCost": "1050.00",
      "receivedAt": "2026-01-30T18:00:00.000Z",
      "product": { "id": "...", "name": "..." },
      "supplier": { "id": "...", "name": "..." }
    }
  ]
}
```

### GET /inventory/receive/location/:locationId/summary

Get receiving summary for a location.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `startDate` | ISO 8601 | Period start |
| `endDate` | ISO 8601 | Period end |

**Response:**
```json
{
  "success": true,
  "data": {
    "period": { "startDate": "...", "endDate": "..." },
    "locationId": "string",
    "totalReceivings": 45,
    "totalQuantity": 5000,
    "totalCost": "25000.00",
    "bySupplier": [
      {
        "supplierId": "string",
        "supplierName": "PharmaCorp",
        "receivings": 20,
        "quantity": 2500,
        "cost": "12500.00"
      }
    ]
  }
}
```

### POST /inventory/receive/:id/retry-square-sync

Retry failed Square sync for a receiving.

**Response:**
```json
{
  "success": true,
  "message": "Successfully synced to Square",
  "data": {
    "synced": true,
    "syncedAt": "2026-01-30T18:00:00.000Z",
    "error": null
  }
}
```

---

## Inventory Adjustments

### POST /inventory/adjustments

Create a generic inventory adjustment.

**Request Body:**
```json
{
  "locationId": "string (required)",
  "productId": "string (required)",
  "type": "AdjustmentType (required)",
  "quantity": "number (required, non-zero)",
  "reason": "string (optional)",
  "notes": "string (optional)",
  "unitCost": "number (optional, for positive adjustments)",
  "effectiveDate": "ISO 8601 (optional)",
  "adjustedBy": "string (optional)",
  "syncToSquare": "boolean (optional, default: false)"
}
```

**Adjustment Types:**
```typescript
enum AdjustmentType {
  DAMAGE = "DAMAGE",           // Negative
  THEFT = "THEFT",             // Negative
  EXPIRED = "EXPIRED",         // Negative
  COUNT_CORRECTION = "COUNT_CORRECTION",  // Variable
  FOUND = "FOUND",             // Positive
  RETURN = "RETURN",           // Positive
  TRANSFER_OUT = "TRANSFER_OUT",  // Negative
  TRANSFER_IN = "TRANSFER_IN",    // Positive
  WRITE_OFF = "WRITE_OFF",     // Negative
  OTHER = "OTHER"              // Variable
}
```

**Response:**
```json
{
  "success": true,
  "message": "Adjustment created successfully: DAMAGE 5 units (synced to Square)",
  "data": {
    "id": "uuid",
    "locationId": "string",
    "productId": "string",
    "type": "DAMAGE",
    "quantity": -5,
    "reason": "Broken during shipping",
    "notes": "Box was crushed",
    "unitCost": "10.50",
    "totalCost": "52.50",
    "createdBatchId": null,
    "adjustedAt": "2026-01-30T18:00:00.000Z",
    "adjustedBy": "user-id",
    "effectiveDate": "2026-01-30T18:00:00.000Z",
    "consumptions": [
      {
        "inventoryId": "uuid",
        "quantity": 5,
        "unitCost": "10.50",
        "totalCost": "52.50"
      }
    ],
    "squareSync": {
      "synced": true,
      "syncedAt": "2026-01-30T18:00:00.000Z",
      "error": null
    }
  }
}
```

### Quick Adjustment Endpoints

These endpoints simplify common adjustment types:

| Endpoint | Type | Quantity Sign |
|----------|------|---------------|
| `POST /inventory/adjustments/damage` | DAMAGE | Always negative |
| `POST /inventory/adjustments/theft` | THEFT | Always negative |
| `POST /inventory/adjustments/expired` | EXPIRED | Always negative |
| `POST /inventory/adjustments/found` | FOUND | Always positive |
| `POST /inventory/adjustments/return` | RETURN | Always positive |
| `POST /inventory/adjustments/count-correction` | COUNT_CORRECTION | As provided |
| `POST /inventory/adjustments/write-off` | WRITE_OFF | Always negative |

**Request Body (same for all):**
```json
{
  "locationId": "string (required)",
  "productId": "string (required)",
  "quantity": "number (required, absolute value)",
  "reason": "string (optional)",
  "notes": "string (optional)",
  "unitCost": "number (optional)",
  "syncToSquare": "boolean (optional)"
}
```

### GET /inventory/adjustments/:id

Get a specific adjustment.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "type": "DAMAGE",
    "quantity": -5,
    "unitCost": "10.50",
    "totalCost": "52.50",
    "reason": "Broken during shipping",
    "adjustedAt": "2026-01-30T18:00:00.000Z",
    "consumptions": [ ... ],
    "createdBatch": null,
    "product": { ... },
    "location": { ... }
  }
}
```

### GET /inventory/adjustments/product/:productId

Get adjustments for a product.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `locationId` | string | Filter by location |

### GET /inventory/adjustments/location/:locationId

Get adjustments for a location.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `startDate` | ISO 8601 | Filter by start date |
| `endDate` | ISO 8601 | Filter by end date |
| `type` | AdjustmentType | Filter by type |
| `limit` | number | Max results |

### GET /inventory/adjustments/location/:locationId/summary

Get adjustment summary for a location.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `startDate` | ISO 8601 | Period start |
| `endDate` | ISO 8601 | Period end |

**Response:**
```json
{
  "success": true,
  "data": {
    "period": { "startDate": "...", "endDate": "..." },
    "locationId": "string",
    "totalAdjustments": 15,
    "totalLoss": "500.00",
    "totalGain": "100.00",
    "netImpact": "-400.00",
    "byType": [
      {
        "type": "DAMAGE",
        "count": 5,
        "totalQuantity": -20,
        "totalCost": "200.00"
      },
      {
        "type": "FOUND",
        "count": 2,
        "totalQuantity": 10,
        "totalCost": "100.00"
      }
    ]
  }
}
```

### GET /inventory/adjustments/types/list

Get all adjustment types with metadata.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "value": "DAMAGE",
      "label": "Damage",
      "isPositive": false,
      "isNegative": true,
      "isVariable": false
    },
    {
      "value": "FOUND",
      "label": "Found",
      "isPositive": true,
      "isNegative": false,
      "isVariable": false
    },
    {
      "value": "COUNT_CORRECTION",
      "label": "Count correction",
      "isPositive": false,
      "isNegative": false,
      "isVariable": true
    }
  ]
}
```

---

## Reports

### GET /inventory/reports/cogs

Cost of Goods Sold report.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `locationId` | string | Filter by location |
| `startDate` | ISO 8601 | Period start |
| `endDate` | ISO 8601 | Period end |
| `groupByCategory` | boolean | Group by category |

**Response:**
```json
{
  "success": true,
  "data": {
    "period": { "startDate": "...", "endDate": "..." },
    "locationId": "string | null",
    "summary": {
      "totalRevenue": "50000.00",
      "totalCOGS": "30000.00",
      "grossProfit": "20000.00",
      "grossMarginPercent": "40.00",
      "totalUnitsSold": 1500,
      "totalSales": 250
    },
    "byProduct": [
      {
        "productId": "uuid",
        "productName": "Aspirin 100mg",
        "unitsSold": 100,
        "revenue": "1500.00",
        "cogs": "800.00",
        "grossProfit": "700.00",
        "marginPercent": "46.67"
      }
    ],
    "byCategory": [
      {
        "categoryId": "uuid",
        "categoryName": "Pain Relief",
        "unitsSold": 500,
        "revenue": "7500.00",
        "cogs": "4000.00",
        "grossProfit": "3500.00",
        "marginPercent": "46.67"
      }
    ]
  }
}
```

### GET /inventory/reports/valuation

Current inventory valuation.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `locationId` | string | Filter by location |
| `productId` | string | Filter by product |

**Response:**
```json
{
  "success": true,
  "data": {
    "asOfDate": "2026-01-30T18:00:00.000Z",
    "locationId": "string | null",
    "summary": {
      "totalUnits": 5000,
      "totalValue": "50000.00",
      "totalProducts": 150,
      "averageCostPerUnit": "10.00"
    },
    "agingSummary": {
      "current": { "units": 3000, "value": "30000.00", "days": "0-30" },
      "aging30": { "units": 1000, "value": "10000.00", "days": "31-60" },
      "aging60": { "units": 500, "value": "5000.00", "days": "61-90" },
      "aging90": { "units": 500, "value": "5000.00", "days": "90+" }
    },
    "byProduct": [
      {
        "productId": "uuid",
        "productName": "Aspirin 100mg",
        "totalQuantity": 200,
        "totalValue": "2000.00",
        "averageCost": "10.00",
        "batches": [
          {
            "batchId": "uuid",
            "quantity": 100,
            "unitCost": "9.50",
            "value": "950.00",
            "receivedAt": "2026-01-15T00:00:00.000Z",
            "ageInDays": 15
          }
        ]
      }
    ]
  }
}
```

### GET /inventory/reports/profit-margin

Profit margin analysis.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `locationId` | string | Filter by location |
| `startDate` | ISO 8601 | Period start |
| `endDate` | ISO 8601 | Period end |

**Response:**
```json
{
  "success": true,
  "data": {
    "period": { "startDate": "...", "endDate": "..." },
    "locationId": "string | null",
    "summary": {
      "totalRevenue": "50000.00",
      "totalCost": "30000.00",
      "grossProfit": "20000.00",
      "marginPercent": "40.00"
    },
    "byProduct": [
      {
        "productId": "uuid",
        "productName": "Aspirin 100mg",
        "revenue": "1500.00",
        "cost": "800.00",
        "profit": "700.00",
        "marginPercent": "46.67",
        "unitsSold": 100
      }
    ],
    "trends": [
      {
        "date": "2026-01-30",
        "revenue": "1500.00",
        "cost": "800.00",
        "profit": "700.00",
        "marginPercent": "46.67"
      }
    ]
  }
}
```

### GET /inventory/reports/adjustment-impact

Adjustment impact analysis.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `locationId` | string | Filter by location |
| `startDate` | ISO 8601 | Period start |
| `endDate` | ISO 8601 | Period end |

**Response:**
```json
{
  "success": true,
  "data": {
    "period": { "startDate": "...", "endDate": "..." },
    "locationId": "string | null",
    "summary": {
      "totalAdjustments": 25,
      "totalLoss": "750.00",
      "totalGain": "150.00",
      "netImpact": "-600.00"
    },
    "byType": [
      {
        "type": "DAMAGE",
        "count": 10,
        "totalQuantity": -50,
        "totalCost": "500.00"
      }
    ]
  }
}
```

### GET /inventory/reports/receiving-summary

Receiving summary report.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `locationId` | string | Filter by location |
| `startDate` | ISO 8601 | Period start |
| `endDate` | ISO 8601 | Period end |

**Response:**
```json
{
  "success": true,
  "data": {
    "period": { "startDate": "...", "endDate": "..." },
    "locationId": "string | null",
    "summary": {
      "totalReceivings": 100,
      "totalQuantity": 10000,
      "totalCost": "80000.00",
      "averageCostPerUnit": "8.00"
    },
    "bySupplier": [
      {
        "supplierId": "uuid",
        "supplierName": "PharmaCorp",
        "receivings": 50,
        "totalQuantity": 5000,
        "totalCost": "40000.00",
        "averageCostPerUnit": "8.00"
      }
    ]
  }
}
```

### GET /inventory/reports/profit-loss

Profit & Loss (Income Statement) report.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `locationId` | string | Filter by location |
| `startDate` | ISO 8601 | Period start |
| `endDate` | ISO 8601 | Period end |

**Response:**
```json
{
  "success": true,
  "data": {
    "period": { "startDate": "...", "endDate": "..." },
    "locationId": "string | null",
    "revenue": {
      "sales": "50000.00",
      "other": "0.00",
      "total": "50000.00"
    },
    "costOfGoodsSold": {
      "productCosts": "30000.00",
      "total": "30000.00"
    },
    "grossProfit": {
      "amount": "20000.00",
      "marginPercent": "40.00"
    },
    "operatingExpenses": {
      "byType": [
        { "type": "PAYROLL", "amount": "8500.00", "percentage": "73.91" },
        { "type": "RENT", "amount": "2500.00", "percentage": "21.74" },
        { "type": "UTILITIES", "amount": "500.00", "percentage": "4.35" }
      ],
      "shrinkage": {
        "amount": "50.00",
        "byType": [
          { "type": "DAMAGE", "amount": "30.00" },
          { "type": "THEFT", "amount": "20.00" }
        ]
      },
      "total": "11550.00"
    },
    "netProfit": {
      "amount": "8450.00",
      "marginPercent": "16.90"
    },
    "summary": {
      "totalSales": 250,
      "totalExpenses": 15,
      "totalAdjustments": 10
    }
  }
}
```

### GET /inventory/reports/dashboard

Consolidated dashboard metrics.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `locationId` | string | Filter by location |
| `startDate` | ISO 8601 | Period start |
| `endDate` | ISO 8601 | Period end |

**Response:**
```json
{
  "success": true,
  "data": {
    "period": { "startDate": "...", "endDate": "..." },
    "locationId": "string | null",
    "sales": {
      "totalRevenue": "50000.00",
      "totalCOGS": "30000.00",
      "grossProfit": "20000.00",
      "grossMarginPercent": "40.00",
      "totalUnitsSold": 1500,
      "totalSales": 250
    },
    "inventory": {
      "totalUnits": 5000,
      "totalValue": "50000.00",
      "totalProducts": 150,
      "averageCostPerUnit": "10.00",
      "aging": { ... }
    },
    "adjustments": {
      "totalAdjustments": 25,
      "totalLoss": "750.00",
      "totalGain": "150.00",
      "netImpact": "-600.00"
    },
    "receivings": {
      "totalReceivings": 100,
      "totalQuantity": 10000,
      "totalCost": "80000.00"
    },
    "operatingExpenses": {
      "total": "11500.00",
      "byType": [ ... ],
      "shrinkage": { ... }
    },
    "netProfit": {
      "amount": "8500.00",
      "marginPercent": "17.00"
    }
  }
}
```

---

## Expenses

### POST /expenses

Create an expense record.

**Request Body:**
```json
{
  "locationId": "string (required)",
  "type": "ExpenseType (required)",
  "amount": "number (required)",
  "date": "ISO 8601 (required)",
  "description": "string (optional)",
  "vendor": "string (optional)",
  "reference": "string (optional)",
  "isPaid": "boolean (optional, default: true)",
  "paidAt": "ISO 8601 (optional)",
  "notes": "string (optional)",
  "createdBy": "string (optional)"
}
```

**Expense Types:**
```typescript
enum ExpenseType {
  RENT = "RENT",
  UTILITIES = "UTILITIES",
  PAYROLL = "PAYROLL",
  INSURANCE = "INSURANCE",
  SUPPLIES = "SUPPLIES",
  MARKETING = "MARKETING",
  MAINTENANCE = "MAINTENANCE",
  TAXES = "TAXES",
  BANK_FEES = "BANK_FEES",
  SOFTWARE = "SOFTWARE",
  PROFESSIONAL = "PROFESSIONAL",
  OTHER = "OTHER"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Expense created: RENT $2500",
  "data": {
    "id": "uuid",
    "locationId": "string",
    "type": "RENT",
    "amount": "2500.00",
    "date": "2026-01-15T00:00:00.000Z",
    "description": "Monthly rent - January 2026",
    "vendor": "Property Management Inc",
    "reference": "INV-12345",
    "isPaid": true,
    "paidAt": "2026-01-15T00:00:00.000Z",
    "notes": null,
    "createdBy": "user-id",
    "createdAt": "2026-01-30T18:00:00.000Z",
    "location": { "id": "...", "name": "Main Store" }
  }
}
```

### GET /expenses

List expenses.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `locationId` | string | Filter by location |
| `type` | ExpenseType | Filter by type |
| `startDate` | ISO 8601 | Filter by start date |
| `endDate` | ISO 8601 | Filter by end date |
| `isPaid` | boolean | Filter by paid status |
| `limit` | number | Max results (default: 100) |

**Response:**
```json
{
  "success": true,
  "count": 15,
  "data": [
    {
      "id": "uuid",
      "type": "RENT",
      "amount": "2500.00",
      "date": "2026-01-15T00:00:00.000Z",
      "vendor": "Property Management Inc",
      "isPaid": true,
      "location": { ... }
    }
  ]
}
```

### GET /expenses/:id

Get a specific expense.

### PUT /expenses/:id

Update an expense.

**Request Body:** Same as POST (all fields optional)

### DELETE /expenses/:id

Delete an expense.

**Response:**
```json
{
  "success": true,
  "message": "Expense deleted"
}
```

### GET /expenses/summary/report

Get expense summary.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `locationId` | string | Filter by location |
| `startDate` | ISO 8601 | Period start |
| `endDate` | ISO 8601 | Period end |
| `includeMonthly` | boolean | Include monthly breakdown |

**Response:**
```json
{
  "success": true,
  "data": {
    "period": { "startDate": "...", "endDate": "..." },
    "locationId": "string | null",
    "totals": {
      "totalExpenses": "11500.00",
      "expenseCount": 15,
      "paidExpenses": "11000.00",
      "unpaidExpenses": "500.00"
    },
    "byType": [
      {
        "type": "PAYROLL",
        "total": "8500.00",
        "count": 1,
        "percentage": "73.91"
      }
    ],
    "byMonth": [
      {
        "month": "2026-01",
        "total": "11500.00",
        "count": 15
      }
    ]
  }
}
```

### GET /expenses/types/list

Get all expense types.

**Response:**
```json
{
  "success": true,
  "data": [
    { "value": "RENT", "label": "Rent" },
    { "value": "UTILITIES", "label": "Utilities" },
    { "value": "PAYROLL", "label": "Payroll" }
  ]
}
```

---

## Reconciliation

### GET /inventory/reconciliation/product/:productId

Reconcile inventory for a product.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `locationId` | string | Required - location ID |

**Response:**
```json
{
  "success": true,
  "reconciliation": {
    "productId": "uuid",
    "productName": "Aspirin 100mg",
    "locationId": "string",
    "currentQuantity": 95,
    "currentValue": "950.00",
    "expectedQuantity": 95,
    "discrepancy": 0,
    "batches": [
      {
        "batchId": "uuid",
        "quantity": 95,
        "unitCost": "10.00",
        "receivedAt": "2026-01-15T00:00:00.000Z"
      }
    ]
  }
}
```

### GET /inventory/reconciliation/location/:locationId

Reconcile all products at a location.

**Response:**
```json
{
  "success": true,
  "reconciliation": {
    "locationId": "string",
    "locationName": "Main Store",
    "totalProducts": 150,
    "productsWithDiscrepancy": 3,
    "totalCurrentValue": "50000.00",
    "totalExpectedValue": "50100.00",
    "valueDiscrepancy": "-100.00",
    "products": [
      {
        "productId": "uuid",
        "productName": "...",
        "currentQuantity": 95,
        "expectedQuantity": 100,
        "discrepancy": -5,
        "currentValue": "950.00"
      }
    ]
  }
}
```

### GET /inventory/reconciliation/consumption/:productId

Get consumption summary for a product.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `locationId` | string | Required |
| `startDate` | ISO 8601 | Period start |
| `endDate` | ISO 8601 | Period end |

**Response:**
```json
{
  "success": true,
  "summary": {
    "productId": "uuid",
    "locationId": "string",
    "periodStart": "2026-01-01T00:00:00.000Z",
    "periodEnd": "2026-01-31T00:00:00.000Z",
    "totalQuantityConsumed": 500,
    "totalCostConsumed": "5000.00",
    "averageUnitCost": "10.00",
    "totalSales": 50,
    "batchesConsumed": 5
  }
}
```

### GET /inventory/reconciliation/sale-item/:saleItemId

Get consumption details for a sale item (FIFO audit trail).

**Response:**
```json
{
  "success": true,
  "saleItemId": "uuid",
  "consumptions": [
    {
      "consumptionId": "uuid",
      "inventoryBatchId": "uuid",
      "batchReceivedAt": "2026-01-10T00:00:00.000Z",
      "quantityConsumed": 5,
      "unitCost": "9.50",
      "totalCost": "47.50",
      "consumedAt": "2026-01-30T18:00:00.000Z"
    },
    {
      "consumptionId": "uuid",
      "inventoryBatchId": "uuid",
      "batchReceivedAt": "2026-01-15T00:00:00.000Z",
      "quantityConsumed": 5,
      "unitCost": "10.00",
      "totalCost": "50.00",
      "consumedAt": "2026-01-30T18:00:00.000Z"
    }
  ],
  "totalBatches": 2,
  "totalQuantity": 10
}
```

### GET /inventory/reconciliation/verify-fifo/:saleId

Verify FIFO compliance for a sale.

**Response:**
```json
{
  "success": true,
  "saleId": "uuid",
  "isCompliant": true,
  "violations": [],
  "items": [
    {
      "saleItemId": "uuid",
      "productName": "Aspirin 100mg",
      "isCompliant": true,
      "consumptions": [ ... ]
    }
  ]
}
```

---

## Error Codes

| Status Code | Description |
|-------------|-------------|
| 200 | Success |
| 400 | Bad Request - Invalid input |
| 401 | Unauthorized - Invalid/missing token |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource doesn't exist |
| 409 | Conflict - Duplicate entry or business rule violation |
| 500 | Internal Server Error |

---

## Rate Limiting (Future)

| Endpoint Type | Limit |
|---------------|-------|
| Read endpoints | 100/minute |
| Write endpoints | 30/minute |
| Report endpoints | 10/minute |

---

*Last Updated: 2026-01-30*
*Version: 1.0*
