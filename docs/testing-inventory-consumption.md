# Testing InventoryConsumption Audit Trail

## Prerequisites

1. **Migration applied**: The `InventoryConsumption` table must exist
2. **API running**: The NestJS API must be running
3. **Sales processed**: At least one sale must have been processed AFTER the migration

## Step 1: Run the Migration

### On Railway (Production/Staging)
```bash
railway run npx prisma migrate deploy
```

### Locally with Docker
```bash
# Start PostgreSQL
npm run db:up

# Run migration
DATABASE_URL="postgresql://user:password@localhost:5432/farmacia" npx prisma migrate deploy
```

## Step 2: Process a Test Sale

### Option A: Use Real Square Webhook
1. Make a purchase in Square POS
2. The webhook will trigger automatically
3. Check worker logs for: `[FIFO_AUDIT] Recorded X consumption records`

### Option B: Use Test Endpoint
```bash
curl -X POST http://localhost:3000/api/webhooks/square/test
```

## Step 3: Verify via API

### Check Sale Item Consumption (FIFO Audit Trail)
```bash
# Get a sale item ID first
curl http://localhost:3000/inventory/reconciliation/sale-item/{saleItemId}
```

Expected response:
```json
{
  "success": true,
  "saleItemId": "...",
  "consumptions": [
    {
      "consumptionId": "...",
      "inventoryBatchId": "...",
      "batchReceivedAt": "2025-01-15T...",
      "quantityConsumed": 2,
      "unitCost": "10.50",
      "totalCost": "21.00",
      "consumedAt": "2025-01-30T..."
    }
  ],
  "totalBatches": 1,
  "totalQuantity": 2
}
```

### Verify FIFO Compliance
```bash
curl http://localhost:3000/inventory/reconciliation/verify-fifo/{saleId}
```

Expected response:
```json
{
  "success": true,
  "saleId": "...",
  "isCompliant": true,
  "violations": []
}
```

### Get Consumption Summary
```bash
curl "http://localhost:3000/inventory/reconciliation/consumption/{productId}?locationId={locationId}&startDate=2025-01-01&endDate=2025-01-31"
```

### Reconcile Product
```bash
curl "http://localhost:3000/inventory/reconciliation/product/{productId}?locationId={locationId}"
```

### Reconcile Location
```bash
curl http://localhost:3000/inventory/reconciliation/location/{locationId}
```

## Step 4: Run Test Script

```bash
# With Railway
railway run npx ts-node scripts/test-inventory-consumption.ts

# Locally
DATABASE_URL="..." npx ts-node scripts/test-inventory-consumption.ts
```

## Step 5: Check Database Directly

### Using Prisma Studio
```bash
npx prisma studio
```
Navigate to `InventoryConsumption` table.

### Using SQL
```sql
-- Count consumption records
SELECT COUNT(*) FROM "InventoryConsumption";

-- Recent consumption with sale info
SELECT 
  ic.id,
  ic.quantity,
  ic.unit_cost,
  ic.total_cost,
  ic.consumed_at,
  i.received_at as batch_received,
  si.quantity as sale_quantity
FROM "InventoryConsumption" ic
JOIN "Inventory" i ON ic."inventoryId" = i.id
JOIN "SaleItem" si ON ic."saleItemId" = si.id
ORDER BY ic.consumed_at DESC
LIMIT 10;
```

## Troubleshooting

### No consumption records after sale
1. Check worker logs for errors
2. Verify sale was processed successfully
3. Ensure migration was applied BEFORE the sale

### Migration failed
```bash
# Check migration status
npx prisma migrate status

# Reset if needed (CAUTION: loses data)
npx prisma migrate reset
```

### API endpoint returns 500
1. Check if table exists: `SELECT * FROM "InventoryConsumption" LIMIT 1;`
2. Check API logs for errors
3. Verify Prisma client was regenerated: `npx prisma generate`
