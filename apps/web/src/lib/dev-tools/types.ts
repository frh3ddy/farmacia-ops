export type SalesTestLocation = {
  id: string;
  name: string;
  squareId: string | null;
  isActive: boolean;
  hasSquareId: boolean;
};

export type ProductWithInventory = {
  id: string;
  name: string;
  sku: string | null;
  displayName: string;
  sellingPrice: number | null;
  totalInventory: number;
  squareVariationId: string | null;
  hasSquareMapping: boolean;
};

export type CartItem = { productId: string; productName: string; quantity: number; price: number };

export type CreateTestSaleResult = {
  eventId: string;
  paymentId: string;
  orderId: string;
  locationId: string;
  locationName: string;
  squareLocationId: string | null;
  lineItems: {
    productId: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    squareVariationId: string;
  }[];
  totalAmount: number;
};

export type QueueStatus = { queueName: string; status: string; note: string };

/** Inventory batch shape from GET /api/inventory (data.controller.ts) */
export type InventoryBatch = {
  id: string;
  productId: string;
  locationId: string;
  quantity: number;
  unitCost: string;
  receivedAt: string;
  createdAt: string;
  product?: { name: string } | null;
  location?: { name: string; squareId: string | null } | null;
};
