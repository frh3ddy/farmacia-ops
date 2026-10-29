import { Injectable, Logger, BadRequestException, BadGatewayException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Square, SquareClient } from 'square';
import { findSquareVariationId, isSquareMapping, preferredMapping } from '../inventory/square-sync';
import { assertCutOver } from '../inventory/cutover-gate';
import { createSquareClient } from '../square/square-client';
import { Prisma, PackagingType, PharmaceuticalForm, AdministrationRoute } from '@prisma/client';
import { findOrCreateActiveIngredient, findOrCreateMedicationDefinition } from './medication-definition';
import { findOrCreateLaboratory } from './laboratory';
import { randomUUID } from 'crypto';
import { deriveName, derivePresentation, type Substance } from './derived-naming';
import { normalizeSearchAliases } from './catalog-search';
import { findSearchMatchIds, sortByIdOrder } from './product-search';
import { productsWithoutCostSql, type ProductWithoutCost } from './products-without-cost';

// Currency constant - must match Square merchant account currency
// Square merchant is configured with USD
const CURRENCY = 'USD';

/** A product as a cashier sees it: stock and selling price, nothing the pharmacy paid. */
export function withoutCosts<
  T extends {
    averageCost?: unknown;
    inventories?: { unitCost?: unknown; costSource?: unknown }[];
    receivings?: { unitCost?: unknown; totalCost?: unknown }[];
  },
>(product: T) {
  const { averageCost, inventories, receivings, ...rest } = product;
  return {
    ...rest,
    ...(inventories && { inventories: inventories.map(({ unitCost, costSource, ...batch }) => batch) }),
    ...(receivings && { receivings: receivings.map(({ unitCost, totalCost, ...receiving }) => receiving) }),
  };
}

/**
 * The only Square location a new item for this product is sold at, or
 * undefined when it is sold everywhere.
 */
function onlySquareLocation(soldAtAllLocations: boolean, squareLocationId?: string | null): string | undefined {
  if (soldAtAllLocations) return undefined;
  if (!squareLocationId) {
    throw new BadRequestException('El producto se vende solo en esta sucursal, y la sucursal no está en Square');
  }
  return squareLocationId;
}

export interface CreateProductInput {
  name: string;
  sku?: string;
  description?: string;
  sellingPrice: number; // Price in dollars (e.g., 45.50)
  costPrice?: number; // Initial cost price in dollars
  initialStock?: number; // Initial inventory quantity
  supplierId?: string; // Supplier the initial stock came from (requires initialStock + costPrice)
  locationId: string; // Required for inventory and Square sync
  syncToSquare?: boolean; // Default true
  categoryId?: string;
  labId?: string;
  medicationType?: 'GENERIC' | 'BRAND' | 'SIMILAR';
  medicationDefinitionId?: string;
  presentation?: string;
  requiresPrescription?: boolean;
  isControlled?: boolean;
  primaryPackaging?: PackagingType;
  secondaryPackaging?: PackagingType;
  quantity?: number;
  // Content of one primary package (e.g. ml per bottle) — see derived-naming.ts.
  primaryContent?: number;
  manualName?: string;
  manualPresentation?: string;
  // Sueltos: links this (box) product to its already-existing loose
  // counterpart Product, so break-bulk knows where converted stock goes.
  looseProductId?: string;
  // Brand-name search tags (e.g. a generic's known brand names: "Tylenol",
  // "Panadol") — matched in catalog-search.service.ts, not a Product relation.
  searchAliases?: string[];
  // Dedup key for a retried create: becomes the product's id.
  clientRequestId?: string;
  // false: sold only at the creating store (e.g. a single toy). Default true.
  soldAtAllLocations?: boolean;
  // Find-or-create by name when labId isn't already known.
  labName?: string;
  // Inline info to find-or-create a medication definition when medicationDefinitionId isn't known.
  medication?: {
    name: string;
    form: PharmaceuticalForm;
    route: AdministrationRoute;
    strength: string;
    activeIngredients: { name: string; concentrationValue?: number; concentrationUnit?: string }[];
  };
}

export interface UpdatePriceInput {
  productId: string;
  sellingPrice: number; // New price in dollars
  locationId: string;
  syncToSquare?: boolean;
  applyToAllLocations?: boolean; // If true, update price at all Square locations
}

export interface ProductResult {
  product: any;
  squareSynced: boolean;
  squareItemId?: string;
  squareVariationId?: string;
  inventoryCreated: boolean;
  message: string;
}

export interface PriceUpdateResult {
  product: any;
  previousPrice: number | null;
  newPrice: number;
  squareSynced: boolean;
  message: string;
}

export interface ImageUploadResult {
  imageUrl: string;
  squareSynced: boolean;
  squareImageId?: string;
  message: string;
}

/** A selling price from untyped JSON: "abc" or NaN would reach the catalog and Square. */
function assertSellingPrice(sellingPrice: unknown): void {
  if (typeof sellingPrice !== 'number' || !Number.isFinite(sellingPrice)) {
    throw new BadRequestException('El precio de venta debe ser un número');
  }
  if (sellingPrice < 0) {
    throw new BadRequestException('El precio de venta no puede ser negativo');
  }
}

const isOneOf = (values: readonly string[], value: unknown) => typeof value === 'string' && values.includes(value);
const medicationTypes = ['GENERIC', 'BRAND', 'SIMILAR'] as const;

/** Refuses the first field that is set but isn't what its name says. */
function assertFieldTypes(fields: Array<[value: unknown, isValid: (value: unknown) => boolean, message: string]>): void {
  const invalid = fields.find(([value, isValid]) => value != null && !isValid(value));
  if (invalid) throw new BadRequestException(invalid[2]);
}

const isWholeNumber = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;

function assertWordList(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new BadRequestException(`${label} deben ser una lista de palabras`);
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  private squareClient: SquareClient | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get or create Square client
   */
  private getSquareClient(): SquareClient {
    this.squareClient ??= createSquareClient();
    if (!this.squareClient) {
      throw new Error('SQUARE_ACCESS_TOKEN environment variable is not set');
    }
    return this.squareClient;
  }

  /**
   * Convert dollar amount to cents (Square uses smallest currency unit)
   */
  private toCents(amount: number): bigint {
    return BigInt(Math.round(amount * 100));
  }

  /**
   * Convert cents to dollars
   */
  private fromCents(cents: number | bigint | null): number | null {
    if (cents === null || cents === undefined) return null;
    return Number(cents) / 100;
  }

  /**
   * Create a new product and optionally sync to Square
   */
  async createProduct(input: CreateProductInput): Promise<ProductResult> {
    if (input.clientRequestId) {
      const replayed = await this.prisma.product.findUnique({
        where: { id: input.clientRequestId },
        include: { catalogMappings: { include: { location: true } }, inventories: true },
      });
      if (replayed) {
        const mapping = preferredMapping(replayed.catalogMappings, input.locationId);
        return {
          product: replayed,
          squareSynced: mapping ? isSquareMapping(mapping) : false,
          squareVariationId: mapping && isSquareMapping(mapping) ? mapping.squareVariationId : undefined,
          inventoryCreated: replayed.inventories.length > 0,
          message: `Product "${replayed.name}" already created`,
        };
      }
    }

    const {
      name,
      sku,
      description,
      sellingPrice,
      costPrice,
      initialStock,
      supplierId,
      locationId,
      syncToSquare = true,
      categoryId,
      medicationType,
      presentation,
      requiresPrescription,
      isControlled,
      primaryPackaging,
      secondaryPackaging,
      quantity,
      primaryContent,
      manualName,
      manualPresentation,
      looseProductId,
      searchAliases,
      clientRequestId,
      soldAtAllLocations = true,
      labName,
      medication,
    } = input;

    this.logger.log(`[PRODUCT] Creating product: ${name}, SKU: ${sku || 'none'}, Price: $${sellingPrice} ${CURRENCY}`);

    const { location } = await this.assertCreatable(input);
    const trimmedSku = sku?.trim() || undefined;
    const productId = clientRequestId ?? randomUUID();

    const labId = input.labId || (labName ? await findOrCreateLaboratory(this.prisma, labName) : undefined);
    let medicationDefinitionId = input.medicationDefinitionId;
    if (!medicationDefinitionId && medication) {
      const ingredients = await Promise.all(
        medication.activeIngredients.map(async (i) => ({
          activeIngredientId: await findOrCreateActiveIngredient(this.prisma, i.name),
          concentrationValue: i.concentrationValue,
          concentrationUnit: i.concentrationUnit,
        })),
      );
      medicationDefinitionId = await findOrCreateMedicationDefinition(this.prisma, {
        name: medication.name,
        form: medication.form,
        route: medication.route,
        strength: medication.strength,
        ingredients,
      });
    }

    // Derived naming/presentación: only for medicamento products
    // (medicationDefinitionId set). 'otro' products keep the directly
    // entered name/presentation untouched. Manual overrides always win.
    let resolvedName = name.trim();
    let resolvedPresentation = presentation?.trim() || null;
    if (medicationDefinitionId) {
      const definition = await this.prisma.medicationDefinition.findUnique({
        where: { id: medicationDefinitionId },
        include: { ingredients: { include: { activeIngredient: true } } },
      });
      if (definition) {
        const substances: Substance[] = definition.ingredients.map((i) => ({
          name: i.activeIngredient.name,
          value: i.concentrationValue !== null ? Number(i.concentrationValue) : null,
          unit: i.concentrationUnit,
          order: i.order,
        }));
        resolvedName = manualName?.trim() || deriveName(substances, definition.form);
        resolvedPresentation =
          manualPresentation?.trim() ||
          derivePresentation(
            definition.form,
            substances,
            quantity ?? null,
            primaryPackaging ?? null,
            secondaryPackaging ?? null,
            primaryContent ?? null,
          );
      }
    }

    let squareItemId: string | undefined;
    let squareVariationId: string | undefined;
    let squareSynced = false;
    let squareError: string | undefined;

    // Step 1: Create in Square (if enabled)
    if (syncToSquare) {
      try {
        const squareResult = await this.createProductInSquare({
          name: resolvedName,
          sku: trimmedSku,
          description,
          sellingPrice,
          onlyAtSquareLocationId: onlySquareLocation(soldAtAllLocations, location.squareId),
        });
        squareItemId = squareResult.itemId;
        squareVariationId = squareResult.variationId;
        squareSynced = true;
        this.logger.log(`[PRODUCT] Created in Square: Item=${squareItemId}, Variation=${squareVariationId}`);
      } catch (error) {
        squareError = error instanceof Error ? error.message : String(error);
        this.logger.error(`[PRODUCT] Failed to create in Square: ${squareError}`);
        // Continue without Square sync - product will be local only
      }
    }

    // Step 2: The product, its price, initial stock and supplier cost, all or nothing
    const priceCents = new Prisma.Decimal(this.toCents(sellingPrice).toString());
    const inventoryCreated = !!initialStock;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.product.create({
          data: {
            id: productId,
            name: resolvedName,
            sku: trimmedSku ?? null,
            squareProductName: resolvedName,
            squareDescription: description || null,
            squareVariationName: 'Regular', // Simple product
            squareDataSyncedAt: squareSynced ? new Date() : null,
            categoryId: categoryId || null,
            labId: labId || null,
            medicationType: medicationType || null,
            medicationDefinitionId: medicationDefinitionId || null,
            presentation: resolvedPresentation,
            requiresPrescription: requiresPrescription ?? false,
            isControlled: isControlled ?? false,
            primaryPackaging: primaryPackaging || null,
            secondaryPackaging: secondaryPackaging || null,
            quantity: quantity ?? null,
            primaryContent: primaryContent ?? null,
            manualName: manualName?.trim() || null,
            manualPresentation: manualPresentation?.trim() || null,
            looseProductId: looseProductId || null,
            searchAliases: searchAliases ? normalizeSearchAliases(searchAliases) : [],
            soldAtAllLocations,
          },
        });

        await tx.catalogMapping.create({
          data: {
            squareVariationId: squareVariationId ?? `local_${productId}`,
            productId,
            locationId,
            priceCents,
            currency: CURRENCY,
            priceSyncedAt: new Date(),
          },
        });

        if (initialStock && costPrice != null) {
          await tx.inventory.create({
            data: {
              locationId,
              productId,
              quantity: initialStock,
              unitCost: new Prisma.Decimal(costPrice),
              receivedAt: new Date(),
              source: 'OPENING_BALANCE',
              costSource: 'MANUAL_INPUT',
            },
          });

          if (supplierId) {
            await tx.supplierProduct.create({
              data: {
                supplierId,
                productId,
                cost: new Prisma.Decimal(costPrice),
                isPreferred: true,
                notes: `Auto-created from initial stock on product creation`,
              },
            });
            await tx.supplierCostHistory.create({
              data: {
                productId,
                supplierId,
                unitCost: new Prisma.Decimal(costPrice),
                effectiveAt: new Date(),
                source: 'MANUAL',
                isCurrent: true,
              },
            });
          }
        }
      });
    } catch (error) {
      if (squareItemId) {
        await this.getSquareClient().catalog.batchDelete({ objectIds: [squareItemId] }).catch((deleteError) =>
          this.logger.error(`[PRODUCT] Failed to delete Square item ${squareItemId} after a failed create: ${deleteError}`),
        );
      }
      throw error;
    }

    if (inventoryCreated) {
      this.logger.log(`[PRODUCT] Created initial inventory: ${initialStock} units @ $${costPrice} ${CURRENCY}`);
      if (squareVariationId && location.squareId) {
        try {
          await this.setInitialInventoryInSquare(squareVariationId, location.squareId, initialStock!, productId);
          this.logger.log(`[PRODUCT] Pushed initial stock to Square: ${initialStock} units`);
        } catch (error) {
          this.logger.error(`[PRODUCT] Failed to push initial stock to Square: ${error}`);
        }
      }
    }

    // Fetch complete product with relations
    const completeProduct = await this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        catalogMappings: {
          include: { location: true },
        },
        inventories: true,
      },
    });

    return {
      product: completeProduct,
      squareSynced,
      squareItemId,
      squareVariationId,
      inventoryCreated,
      message: squareSynced
        ? `Product "${resolvedName}" created and synced to Square`
        : `Product "${resolvedName}" created locally (Square sync ${syncToSquare ? `failed: ${squareError}` : 'disabled'})`,
    };
  }

  /**
   * Refuses a create that would fail part-way, before anything is written in
   * Square or the database (laboratories and medication definitions included).
   */
  private async assertCreatable(input: CreateProductInput) {
    const { name, sku, sellingPrice, costPrice, initialStock, quantity, supplierId, locationId, clientRequestId } = input;
    if (!name || name.trim().length === 0) {
      throw new BadRequestException('El nombre del producto es obligatorio');
    }
    assertSellingPrice(sellingPrice);
    if (costPrice != null && (typeof costPrice !== 'number' || !Number.isFinite(costPrice) || costPrice < 0)) {
      throw new BadRequestException('El costo debe ser un número de 0 o más');
    }
    if (initialStock != null && !isWholeNumber(initialStock)) {
      throw new BadRequestException('Las existencias iniciales deben ser un número entero de 0 o más');
    }
    if (quantity != null && !isWholeNumber(quantity)) {
      throw new BadRequestException('La cantidad por caja debe ser un número entero de 0 o más');
    }
    if (initialStock && costPrice == null) {
      throw new BadRequestException('Las existencias iniciales necesitan un costo');
    }
    const isBoolean = (value: unknown) => typeof value === 'boolean';
    const isText = (value: unknown) => typeof value === 'string';
    const isPackaging = (value: unknown) => isOneOf(Object.values(PackagingType), value);
    assertFieldTypes([
      [sku, isText, 'El SKU debe ser texto'],
      [input.medicationType, (v) => isOneOf(medicationTypes, v), 'El tipo de medicamento no es válido'],
      [input.primaryPackaging, isPackaging, 'El empaque primario no es válido'],
      [input.secondaryPackaging, isPackaging, 'El empaque secundario no es válido'],
      [input.requiresPrescription, isBoolean, '"Requiere receta" debe ser sí o no'],
      [input.isControlled, isBoolean, '"Sustancia controlada" debe ser sí o no'],
      [input.syncToSquare, isBoolean, '"Enviar a Square" debe ser sí o no'],
      [input.soldAtAllLocations, isBoolean, '"Vender en todas las sucursales" debe ser sí o no'],
    ]);
    if (input.medication) {
      const { name, strength, form, route, activeIngredients } = input.medication;
      if (!Array.isArray(activeIngredients)) {
        throw new BadRequestException('El medicamento necesita su lista de principios activos');
      }
      if (!activeIngredients.every((i) => typeof i?.name === 'string' && i.name.trim())) {
        throw new BadRequestException('Cada principio activo necesita un nombre');
      }
      if (!isOneOf(Object.values(PharmaceuticalForm), form) || !isOneOf(Object.values(AdministrationRoute), route)) {
        throw new BadRequestException('La forma o la vía del medicamento no son válidas');
      }
      if (typeof name !== 'string' || typeof strength !== 'string') {
        throw new BadRequestException('El medicamento necesita nombre y concentración');
      }
    }
    if (clientRequestId !== undefined && (typeof clientRequestId !== 'string' || !UUID.test(clientRequestId))) {
      throw new BadRequestException('clientRequestId must be a UUID');
    }

    const location = await this.prisma.location.findUnique({ where: { id: locationId } });
    if (!location) {
      throw new NotFoundException(`Location ${locationId} not found`);
    }
    if (initialStock) {
      await assertCutOver(this.prisma, locationId);
    }

    const trimmedSku = sku?.trim();
    if (trimmedSku) {
      const existingProduct = await this.prisma.product.findUnique({ where: { sku: trimmedSku } });
      if (existingProduct && existingProduct.id !== clientRequestId) {
        throw new BadRequestException(`Ya existe un producto con el SKU "${trimmedSku}"`);
      }
    }

    if (supplierId) {
      const supplier = await this.prisma.supplier.findUnique({ where: { id: supplierId } });
      if (!supplier) {
        throw new NotFoundException(`Supplier ${supplierId} not found`);
      }
    }

    const references: Array<[id: string | undefined, find: (id: string) => Promise<unknown>, message: string]> = [
      [input.categoryId, (id) => this.prisma.category.findUnique({ where: { id } }), 'La categoría no existe'],
      [input.labId, (id) => this.prisma.laboratory.findUnique({ where: { id } }), 'El laboratorio no existe'],
      [input.medicationDefinitionId, (id) => this.prisma.medicationDefinition.findUnique({ where: { id } }), 'El medicamento no existe'],
      [input.looseProductId, (id) => this.prisma.product.findUnique({ where: { id } }), 'El producto suelto no existe'],
    ];
    for (const [id, find, message] of references) {
      if (id && !(await find(id))) throw new BadRequestException(message);
    }

    return { location };
  }

  /**
   * Sync all local-only products to Square
   * Finds products with local_ prefix in their catalog mapping and creates them in Square
   */
  async syncUnsyncedProducts(locationId: string): Promise<{
    total: number;
    synced: number;
    failed: number;
    results: Array<{ productId: string; name: string; success: boolean; error?: string }>;
  }> {
    this.logger.log(`[SYNC] Starting bulk sync of unsynced products for location ${locationId}`);

    // Find all catalog mappings with local_ prefix for this location
    const localMappings = await this.prisma.catalogMapping.findMany({
      where: {
        squareVariationId: { startsWith: 'local_' },
        locationId,
      },
      include: {
        product: true,
        location: true,
      },
    });

    if (localMappings.length === 0) {
      return { total: 0, synced: 0, failed: 0, results: [] };
    }

    this.logger.log(`[SYNC] Found ${localMappings.length} unsynced products`);

    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
    });

    const results: Array<{ productId: string; name: string; success: boolean; error?: string }> = [];
    let synced = 0;
    let failed = 0;

    for (const mapping of localMappings) {
      const product = mapping.product;
      const price = this.fromCents(Number(mapping.priceCents)) || 0;

      try {
        const existingVariationId = await findSquareVariationId(this.prisma, product.id, locationId);
        if (existingVariationId) {
          await this.adoptPlaceholder(mapping, existingVariationId);
          synced++;
          results.push({ productId: product.id, name: product.name, success: true });
          this.logger.log(`[SYNC] ✅ ${product.name} already in Square → variation ${existingVariationId}`);
          continue;
        }

        const squareResult = await this.createProductInSquare({
          name: product.name,
          sku: product.sku || undefined,
          description: product.squareDescription || undefined,
          sellingPrice: price,
          onlyAtSquareLocationId: onlySquareLocation(product.soldAtAllLocations, location?.squareId),
          productId: product.id,
        });

        // Update catalog mapping with real Square ID
        await this.prisma.catalogMapping.update({
          where: { id: mapping.id },
          data: {
            squareVariationId: squareResult.variationId,
            priceSyncedAt: new Date(),
          },
        });

        // Update product sync timestamp
        await this.prisma.product.update({
          where: { id: product.id },
          data: { squareDataSyncedAt: new Date() },
        });

        synced++;
        results.push({ productId: product.id, name: product.name, success: true });
        this.logger.log(`[SYNC] ✅ ${product.name} → Square variation ${squareResult.variationId}`);
      } catch (error) {
        failed++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.push({ productId: product.id, name: product.name, success: false, error: errorMsg });
        this.logger.error(`[SYNC] ❌ ${product.name} failed: ${errorMsg}`);
      }
    }

    this.logger.log(`[SYNC] Bulk sync complete: ${synced} synced, ${failed} failed out of ${localMappings.length}`);

    return {
      total: localMappings.length,
      synced,
      failed,
      results,
    };
  }

  /**
   * Create product in Square
   */
  private async createProductInSquare(input: {
    name: string;
    sku?: string;
    description?: string;
    sellingPrice: number;
    // Sold only at this Square location; omitted, sold everywhere.
    onlyAtSquareLocationId?: string;
    // Keys the Square call to this local product's own id so a retry (e.g.
    // the bulk unsynced-products sweep or a re-run of updatePrice's backfill
    // path) replays the same idempotency key instead of creating a second
    // duplicate Square item. Omitted only when called from createProduct(),
    // before the local Product row exists to key off of.
    productId?: string;
  }): Promise<{ itemId: string; variationId: string }> {
    const client = this.getSquareClient();
    const idempotencyKey = input.productId ?? randomUUID();

    // Generate temporary IDs for the request
    const tempItemId = `#item_${idempotencyKey}`;
    const tempVariationId = `#variation_${idempotencyKey}`;
    // The variation is sold exactly where its item is: Square rejects a variation present beyond its item.
    const presence = input.onlyAtSquareLocationId
      ? { presentAtAllLocations: false, presentAtLocationIds: [input.onlyAtSquareLocationId] }
      : {};

    const response = await client.catalog.object.upsert({
      idempotencyKey,
      object: {
        type: 'ITEM',
        id: tempItemId,
        ...presence,
        itemData: {
          name: input.name,
          description: input.description || undefined,
          variations: [
            {
              type: 'ITEM_VARIATION',
              id: tempVariationId,
              ...presence,
              itemVariationData: {
                itemId: tempItemId,
                name: 'Regular', // Simple product - single variation
                sku: input.sku || undefined,
                pricingType: 'FIXED_PRICING',
                priceMoney: {
                  amount: this.toCents(input.sellingPrice),
                  currency: CURRENCY,
                },
                trackInventory: true,
              },
            },
          ],
        },
      },
    });

    // Extract real IDs from response
    const catalogObject = response.catalogObject;
    if (!catalogObject) {
      throw new Error('No catalog object returned from Square');
    }

    const itemId = catalogObject.id;
    const itemData = (catalogObject as any).itemData;
    const variations = itemData?.variations || [];
    const variationId = variations[0]?.id;

    if (!itemId || !variationId) {
      throw new Error('Failed to get item/variation IDs from Square response');
    }

    return { itemId, variationId };
  }

  /**
   * Set the opening physical count for a newly created variation in Square.
   * Keyed off the local product id so a retry replays the same idempotency key.
   */
  private async setInitialInventoryInSquare(
    variationId: string,
    squareLocationId: string,
    quantity: number,
    productId: string,
  ): Promise<void> {
    const client = this.getSquareClient();

    await client.inventory.batchCreateChanges({
      idempotencyKey: `initial_stock_${productId}`,
      changes: [
        {
          type: 'PHYSICAL_COUNT',
          physicalCount: {
            catalogObjectId: variationId,
            state: 'IN_STOCK',
            locationId: squareLocationId,
            quantity: quantity.toString(),
            occurredAt: new Date().toISOString(),
          },
        },
      ],
    });
  }

  /**
   * Update product selling price and sync to Square: the base price for every
   * location, or one location's own price. Never changes where the item is sold.
   */
  async updatePrice(input: UpdatePriceInput): Promise<PriceUpdateResult> {
    const { productId, sellingPrice, locationId, syncToSquare = true, applyToAllLocations = false } = input;

    this.logger.log(`[PRODUCT] Updating price for product ${productId} to $${sellingPrice} ${CURRENCY}${applyToAllLocations ? ' (all locations)' : ''}`);

    assertSellingPrice(sellingPrice);

    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { catalogMappings: { orderBy: { createdAt: 'desc' } } },
    });

    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }
    if (product.catalogMappings.some((m) => m.employeeId)) {
      throw new BadRequestException('Los productos Yastás no tienen precio fijo: su ingreso se registra en la pantalla de Yastás');
    }

    const shown = preferredMapping(product.catalogMappings, locationId);
    const previousPrice = shown ? this.fromCents(Number(shown.priceCents)) : null;
    const placeholder = preferredMapping(product.catalogMappings.filter((m) => !isSquareMapping(m)), locationId);
    let squareVariationId = preferredMapping(product.catalogMappings.filter(isSquareMapping), locationId)?.squareVariationId;

    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
    });

    // Step 1: Send to Square when the change has somewhere to go there; a
    // rejected change is refused, so the app never shows a price the register doesn't charge.
    const reachesSquare =
      syncToSquare &&
      (squareVariationId
        ? applyToAllLocations || !!location?.squareId
        : !!placeholder && (product.soldAtAllLocations || !!location?.squareId));
    if (reachesSquare) {
      try {
        if (squareVariationId) {
          await this.updatePriceInSquare(squareVariationId, sellingPrice, applyToAllLocations ? undefined : location!.squareId!);
          this.logger.log(`[PRODUCT] Price updated in Square for variation ${squareVariationId}${applyToAllLocations ? ' (all locations)' : ''}`);
        } else {
          const squareResult = await this.createProductInSquare({
            name: product.name,
            sku: product.sku || undefined,
            description: product.squareDescription || undefined,
            sellingPrice,
            onlyAtSquareLocationId: onlySquareLocation(product.soldAtAllLocations, location?.squareId),
            productId,
          });
          squareVariationId = squareResult.variationId;
          this.logger.log(`[PRODUCT] Product synced to Square: Item=${squareResult.itemId}, Variation=${squareResult.variationId}`);
        }
      } catch (error) {
        this.logger.error(`[PRODUCT] Square refused the price change for ${productId}: ${error}`);
        throw new BadGatewayException('Square no aceptó el cambio de precio, así que el precio no cambió. Inténtalo de nuevo.');
      }
    }
    const squareSynced = reachesSquare;

    // Step 2: Update the cached prices
    if (placeholder && squareVariationId) {
      await this.adoptPlaceholder(placeholder, squareVariationId);
    }
    const priced = {
      priceCents: new Prisma.Decimal(this.toCents(sellingPrice).toString()),
      priceSyncedAt: new Date(),
    };
    const { count } = applyToAllLocations
      ? await this.prisma.catalogMapping.updateMany({ where: { productId }, data: priced })
      : { count: 0 };
    if (count === 0) {
      const ownVariationId = squareVariationId ?? `local_${productId}`;
      await this.prisma.catalogMapping.upsert({
        where: { squareVariationId_locationId: { squareVariationId: ownVariationId, locationId } },
        update: priced,
        create: { ...priced, squareVariationId: ownVariationId, productId, locationId, currency: CURRENCY },
      });
    }

    // Fetch updated product with all required fields including inventory
    const updatedProduct = await this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        category: true,
        catalogMappings: {
          orderBy: { createdAt: 'desc' },
          include: { location: true },
        },
        inventories: {
          where: { locationId },
        },
      },
    });

    // Calculate total inventory
    const totalInventory = updatedProduct?.inventories.reduce((sum, inv) => sum + inv.quantity, 0) || 0;
    
    // Calculate average cost from inventory
    const totalCost = updatedProduct?.inventories.reduce(
      (sum, inv) => sum + (inv.quantity * Number(inv.unitCost)),
      0
    ) || 0;
    const averageCost = totalInventory > 0 ? totalCost / totalInventory : null;

    const responseMapping = updatedProduct && preferredMapping(updatedProduct.catalogMappings, locationId);

    return {
      product: updatedProduct ? {
        ...updatedProduct,
        sellingPrice,
        currency: CURRENCY,
        totalInventory,
        averageCost,
        hasSquareSync: responseMapping ? isSquareMapping(responseMapping) : false,
      } : null,
      previousPrice,
      newPrice: sellingPrice,
      squareSynced,
      message: squareSynced
        ? `Precio actualizado a $${sellingPrice} ${CURRENCY} y enviado a Square`
        : `Precio actualizado a $${sellingPrice} ${CURRENCY} solo en la app (no se envió a Square)`,
    };
  }

  /**
   * Points a `local_` placeholder at the product's real Square item, or drops
   * it when the location already has a mapping to that item.
   */
  private async adoptPlaceholder(placeholder: { id: string; locationId: string | null }, squareVariationId: string) {
    const taken = await this.prisma.catalogMapping.findFirst({
      where: { squareVariationId, locationId: placeholder.locationId },
    });
    if (taken) {
      await this.prisma.catalogMapping.delete({ where: { id: placeholder.id } });
    } else {
      await this.prisma.catalogMapping.update({ where: { id: placeholder.id }, data: { squareVariationId } });
    }
  }

  /**
   * Sets a variation's price in Square: one location's own price when
   * `squareLocationId` is given, else the base price for every location
   * (dropping the locations' own prices). Everything else on the variation,
   * including where it is sold, is sent back as Square returned it.
   */
  private async updatePriceInSquare(variationId: string, newPrice: number, squareLocationId?: string): Promise<void> {
    const client = this.getSquareClient();
    const { object } = await client.catalog.object.get({ objectId: variationId });
    if (object?.type !== 'ITEM_VARIATION' || !object.itemVariationData) {
      throw new Error(`Variation ${variationId} not found in Square`);
    }
    const variationData = object.itemVariationData;

    const price = { amount: this.toCents(newPrice), currency: CURRENCY } as const;
    const overrides = variationData.locationOverrides ?? [];
    const itemVariationData: Square.CatalogItemVariation = squareLocationId
      ? {
          ...variationData,
          locationOverrides: [
            ...overrides.filter((o) => o.locationId !== squareLocationId),
            { ...overrides.find((o) => o.locationId === squareLocationId), locationId: squareLocationId, priceMoney: price, pricingType: 'FIXED_PRICING' },
          ],
        }
      : {
          ...variationData,
          pricingType: 'FIXED_PRICING',
          priceMoney: price,
          locationOverrides: overrides
            .map(({ priceMoney, pricingType, ...rest }) => rest)
            .filter((o) => Object.keys(o).some((key) => key !== 'locationId')),
        };

    this.logger.log(`[PRODUCT] Updating price for variation ${variationId} ${squareLocationId ? `at location ${squareLocationId}` : 'at all locations'}`);
    await client.catalog.object.upsert({
      idempotencyKey: randomUUID(),
      object: { ...object, itemVariationData },
    });
  }

  /**
   * `Product`/`CatalogMapping` only ever store the ITEM_VARIATION id — never
   * the parent ITEM id — so every operation that needs the parent (delete,
   * rename) resolves it the same way: fetch the variation object and read
   * itemVariationData.itemId off it.
   */
  private async resolveParentItemId(variationId: string): Promise<string> {
    const client = this.getSquareClient();
    const retrieveResponse = await client.catalog.object.get({ objectId: variationId });
    const currentObject = retrieveResponse.object;
    const variationData = (currentObject as any)?.itemVariationData;
    const parentItemId = variationData?.itemId;
    if (!parentItemId) {
      throw new Error(`Could not resolve parent item for Square variation ${variationId}`);
    }
    return parentItemId;
  }

  /**
   * Permanently retires a catalog item in Square. `variationId` is an
   * ITEM_VARIATION catalog object ID (what inventory rows store) — this
   * resolves its parent ITEM id and deletes that, since BatchDeleteCatalogObjects
   * cascades to all of an ITEM's variations, and deleting only a variation
   * would leave the parent item and any sibling variations intact.
   */
  async deleteCatalogItem(variationId: string): Promise<void> {
    const client = this.getSquareClient();
    const parentItemId = await this.resolveParentItemId(variationId);

    await client.catalog.batchDelete({ objectIds: [parentItemId] });
    this.logger.log(`[PRODUCT] Deleted Square catalog item ${parentItemId} (via variation ${variationId})`);
  }

  /**
   * Renames the parent ITEM's display name in Square. Mirrors
   * updatePriceInSquare's fetch-preserve-upsert shape: CatalogObject upsert
   * is a full-object replace, and CatalogItem.variations is required
   * ("an item must have at least one variation"), so the current itemData
   * (including its nested variations) is spread back untouched and only
   * `name` is overridden — never build the object from scratch here.
   */
  async renameProductInSquare(variationId: string, newName: string): Promise<void> {
    const client = this.getSquareClient();
    const parentItemId = await this.resolveParentItemId(variationId);

    const retrieveResponse = await client.catalog.object.get({ objectId: parentItemId });
    const currentObject = retrieveResponse.object;
    if (!currentObject) {
      throw new Error(`Item ${parentItemId} not found in Square`);
    }

    const itemData = (currentObject as any).itemData;
    if (!itemData) {
      throw new Error(`Invalid item data for ${parentItemId}`);
    }

    const upsertObject: any = {
      type: 'ITEM',
      id: parentItemId,
      version: currentObject.version,
      itemData: { ...itemData, name: newName },
    };

    // Preserve item-level location settings — same fields/logic as
    // updatePriceInSquare preserves at the variation level.
    if (currentObject.presentAtAllLocations !== undefined) {
      upsertObject.presentAtAllLocations = currentObject.presentAtAllLocations;
    }
    if (currentObject.presentAtLocationIds) {
      upsertObject.presentAtLocationIds = currentObject.presentAtLocationIds;
    }
    if (currentObject.absentAtLocationIds) {
      upsertObject.absentAtLocationIds = currentObject.absentAtLocationIds;
    }

    await client.catalog.object.upsert({
      idempotencyKey: randomUUID(),
      object: upsertObject,
    });
    this.logger.log(`[PRODUCT] Renamed Square item ${parentItemId} (via variation ${variationId}) to "${newName}"`);
  }

  /**
   * Upload product image — stream directly to Square, no disk storage.
   * The image buffer is sent to Square's Catalog API and the returned
   * Square-hosted URL is persisted in the database.
   */
  async uploadProductImage(
    productId: string,
    imageBuffer: Buffer,
    mimeType: string,
  ): Promise<ImageUploadResult> {
    // Verify product exists
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        catalogMappings: true,
      },
    });
    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    let squareSynced = false;
    let squareImageId: string | undefined;
    let finalImageUrl: string | null = null;

    // Find the Square variation ID (skip local-only mappings)
    const squareMapping = product.catalogMappings.find(
      (m) => !m.squareVariationId.startsWith('local_'),
    );

    if (squareMapping) {
      try {
        const result = await this.uploadImageToSquare(
          squareMapping.squareVariationId,
          imageBuffer,
          mimeType,
          product.name,
        );
        squareSynced = true;
        squareImageId = result.imageId;
        if (result.imageUrl) {
          finalImageUrl = result.imageUrl;
        }
        this.logger.log(
          `[PRODUCT] Image uploaded to Square: imageId=${squareImageId}, url=${finalImageUrl}`,
        );
      } catch (error) {
        this.logger.error(`[PRODUCT] Failed to upload image to Square: ${error}`);
        // No fallback — we don't store files locally anymore.
        // The product keeps its existing image (if any).
        return {
          imageUrl: product.squareImageUrl || '',
          squareSynced: false,
          message: `Failed to upload image to Square: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    } else {
      // Product has no Square catalog mapping — cannot upload
      return {
        imageUrl: product.squareImageUrl || '',
        squareSynced: false,
        message: 'Product is not synced to Square. Image upload requires a Square catalog mapping.',
      };
    }

    // Update product with the Square-hosted image URL
    if (finalImageUrl) {
      await this.prisma.product.update({
        where: { id: productId },
        data: { squareImageUrl: finalImageUrl },
      });
    }

    return {
      imageUrl: finalImageUrl || product.squareImageUrl || '',
      squareSynced,
      squareImageId,
      message: 'Product image uploaded to Square',
    };
  }

  /**
   * Upload image to Square and attach to the parent catalog item.
   * Accepts a raw Buffer — no file system access needed.
   */
  private async uploadImageToSquare(
    squareVariationId: string,
    imageBuffer: Buffer,
    mimeType: string,
    productName: string,
  ): Promise<{ imageId: string; imageUrl: string | null }> {
    const client = this.getSquareClient();

    // Step 1: Retrieve the variation to get the parent item ID
    const variationResponse = await client.catalog.object.get({
      objectId: squareVariationId,
    });

    const variationObject = variationResponse.object;
    if (!variationObject) {
      throw new Error(
        `Variation ${squareVariationId} not found in Square`,
      );
    }

    const variationData = (variationObject as any).itemVariationData;
    const parentItemId = variationData?.itemId;
    if (!parentItemId) {
      throw new Error(
        `Cannot determine parent item for variation ${squareVariationId}`,
      );
    }

    // Step 2: Upload image directly from the in-memory buffer
    const idempotencyKey = randomUUID();

    // Ensure MIME type is one Square accepts
    const allowedMimes = ['image/jpeg', 'image/pjpeg', 'image/png', 'image/x-png', 'image/gif'];
    const safeMime = allowedMimes.includes(mimeType) ? mimeType : 'image/jpeg';
    const imageFile = new Blob([new Uint8Array(imageBuffer)], { type: safeMime });

    const response = await client.catalog.images.create({
      request: {
        idempotencyKey,
        objectId: parentItemId,
        image: {
          type: 'IMAGE',
          id: `#image_${idempotencyKey}`,
          imageData: {
            name: productName,
            caption: productName,
          },
        },
        isPrimary: true,
      },
      imageFile,
    });

    const catalogImage = response.image;
    const imageId = catalogImage?.id || '';
    const imageUrl =
      (catalogImage as any)?.imageData?.url || null;

    return { imageId, imageUrl };
  }

  /** Square-synced products with no cost yet — see products-without-cost.ts. */
  async findWithoutCost(): Promise<{ success: true; data: ProductWithoutCost[] }> {
    return { success: true, data: await this.prisma.$queryRaw<ProductWithoutCost[]>(productsWithoutCostSql) };
  }

  /** Ranked product ids for a free-text search — see product-search.ts. */
  private findSearchMatchIds(search: string, locationId?: string): Promise<string[]> {
    return findSearchMatchIds(search, (sql) => this.prisma.$queryRaw<{ id: string }[]>(sql), locationId);
  }

  /**
   * Get products with optional pagination and search
   *
   * When page/limit are provided the response includes pagination metadata:
   *   { success, data, count, page, limit, totalCount, totalPages, hasMore }
   *
   * This keeps backward-compatibility: the old un-paginated call returns the
   * same { success, data, count } shape (plus the new fields, which older
   * clients simply ignore).
   */
  async getProducts(
    locationId?: string,
    options?: { page?: number; limit?: number; search?: string; exact?: boolean },
  ) {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 50;
    const search = options?.search;
    const exact = options?.exact ?? false;
    const skip = (page - 1) * limit;

    // Common include block (shared between count and findMany)
    const includeBlock = {
      category: true,
      catalogMappings: {
        orderBy: { createdAt: 'desc' as const },
        include: {
          location: true,
        },
      },
      inventories: locationId
        ? {
            where: { locationId },
          }
        : true,
    };

    // Build a `where` clause for optional search
    let where: Prisma.ProductWhereInput = {};
    let exactMatch = false;
    // Ids of a text search, already in relevance order (null = not a text
    // search). Ranking has to happen in SQL — see product-search.ts — so the
    // requested page is sliced out of this list and `findMany` only hydrates
    // those rows, keeping the order via sortByIdOrder below.
    let rankedIds: string[] | null = null;

    if (search && exact) {
      // EXACT mode: first try exact SKU match (case-insensitive)
      const exactWhere: Prisma.ProductWhereInput = {
        sku: { equals: search, mode: 'insensitive' },
      };

      const exactCount = await this.prisma.product.count({ where: exactWhere });

      if (exactCount > 0) {
        // Found exact SKU match(es)
        where = exactWhere;
        exactMatch = true;
      } else {
        // Misread/partial barcode — fall back to the same ranked fuzzy search
        // the product list uses, so the scanner's candidate list is useful.
        rankedIds = await this.findSearchMatchIds(search, locationId);
        exactMatch = false;
      }
    } else if (search) {
      rankedIds = await this.findSearchMatchIds(search, locationId);
    }

    if (rankedIds) {
      where = { id: { in: rankedIds.slice(skip, skip + limit) } };
    }

    // Fetch total count and page of products in parallel
    const [totalCount, products] = await Promise.all([
      rankedIds ? Promise.resolve(rankedIds.length) : this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        include: includeBlock,
        orderBy: { createdAt: 'desc' },
        // The page was already sliced out of rankedIds above.
        skip: rankedIds ? 0 : skip,
        take: limit,
      }),
    ]);

    // Transform products to include computed fields
    const transformedProducts = (rankedIds ? sortByIdOrder(products, rankedIds) : products).map((product) => {
      const mapping = preferredMapping(product.catalogMappings, locationId);
      const totalInventory = product.inventories.reduce((sum, inv) => sum + inv.quantity, 0);
      // Average cost across the location's FIFO batches (same formula as getProduct)
      const totalCost = product.inventories.reduce(
        (sum, inv) => sum + inv.quantity * Number(inv.unitCost),
        0,
      );
      const averageCost = totalInventory > 0 ? totalCost / totalInventory : null;
      
      return {
        ...product,
        sellingPrice: mapping ? this.fromCents(Number(mapping.priceCents)) : null,
        currency: mapping?.currency || CURRENCY,
        totalInventory,
        averageCost,
        hasSquareSync: mapping ? isSquareMapping(mapping) : false,
      };
    });

    const totalPages = Math.ceil(totalCount / limit);

    return {
      success: true,
      data: transformedProducts,
      count: transformedProducts.length,
      // Pagination metadata
      page,
      limit,
      totalCount,
      totalPages,
      hasMore: page < totalPages,
      // Barcode scanner hint: true if exact SKU matched, false if fell back to contains
      exactMatch,
    };
  }

  /**
   * Lightweight stock/margin alert counts for a location (Dashboard alerts).
   * Uses SQL aggregates + window functions instead of transferring full product
   * rows. Thresholds mirror the iOS app: outOfStock qty<=0, lowStock 1-9,
   * lowMargin < 10% (margin computed from selling price vs weighted average cost
   * of the location's FIFO batches).
   */
  async getProductCounts(locationId?: string) {
    if (!locationId) {
      throw new BadRequestException('Location ID is required');
    }

    const stats = await this.prisma.$queryRaw<
      Array<{
        total: bigint;
        out_of_stock: bigint;
        low_stock: bigint;
        low_margin: bigint;
        synced: bigint;
        local: bigint;
      }>
    >(Prisma.sql`
      WITH inv AS (
        SELECT "productId",
               SUM(quantity) AS qty,
               SUM(quantity * "unitCost") AS total_cost
        FROM "Inventory"
        WHERE "locationId" = ${locationId}
        GROUP BY "productId"
      ),
      -- Same mapping preference as preferredMapping (square-sync.ts): real Square
      -- items before placeholders, then the location's, the global one, any other;
      -- another location's placeholder never counts
      mapping AS (
        SELECT DISTINCT ON ("productId") "productId", "priceCents", "squareVariationId", "locationId"
        FROM "CatalogMapping"
        WHERE "squareVariationId" NOT LIKE 'local_%' OR "locationId" = ${locationId} OR "locationId" IS NULL
        ORDER BY "productId",
                 "squareVariationId" LIKE 'local_%',
                 "locationId" IS DISTINCT FROM ${locationId},
                 "locationId" IS NOT NULL,
                 "createdAt" DESC
      )
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE COALESCE(inv.qty, 0) <= 0)::bigint AS out_of_stock,
        COUNT(*) FILTER (WHERE COALESCE(inv.qty, 0) > 0 AND COALESCE(inv.qty, 0) < 10)::bigint AS low_stock,
        COUNT(*) FILTER (
          WHERE m."priceCents" IS NOT NULL
            AND inv.qty IS NOT NULL
            AND inv.qty > 0
            AND (m."priceCents" / 100.0 - (inv.total_cost / inv.qty))
                / NULLIF(m."priceCents" / 100.0, 0) * 100 < 10
        )::bigint AS low_margin,
        COUNT(*) FILTER (WHERE m."squareVariationId" IS NOT NULL AND NOT m."squareVariationId" LIKE 'local_%')::bigint AS synced,
        -- Must match what syncUnsyncedProducts can push: location-scoped local_ mappings only.
        -- Unmapped products have no price to send, so they are not "pending sync".
        COUNT(*) FILTER (WHERE m."locationId" IS NOT NULL AND m."squareVariationId" LIKE 'local_%')::bigint AS local
      FROM "Product" p
      LEFT JOIN inv ON inv."productId" = p.id
      LEFT JOIN mapping m ON m."productId" = p.id
    `);

    const row = stats[0];
    return {
      success: true,
      data: {
        total: Number(row?.total ?? 0),
        outOfStock: Number(row?.out_of_stock ?? 0),
        lowStock: Number(row?.low_stock ?? 0),
        lowMargin: Number(row?.low_margin ?? 0),
        synced: Number(row?.synced ?? 0),
        local: Number(row?.local ?? 0),
      },
    };
  }

  /** The products a supplier provides, with its last cost and the location's stock. */
  async getSupplierCatalog(supplierId: string, targetLocationId?: string) {
    // Get all products this supplier provides
    const supplierProducts = await this.prisma.supplierProduct.findMany({
      where: { supplierId },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            squareProductName: true,
            squareVariationName: true,
            squareImageUrl: true,
            inventories: targetLocationId
              ? { where: { locationId: targetLocationId } }
              : true,
          },
        },
      },
      orderBy: {
        product: { name: 'asc' },
      },
    });

    return supplierProducts.map((sp) => {
      const totalStock = sp.product.inventories.reduce((sum, inv) => sum + inv.quantity, 0);
      return {
        productId: sp.product.id,
        productName: sp.product.squareProductName || sp.product.name,
        sku: sp.product.sku,
        imageUrl: sp.product.squareImageUrl,
        lastCost: sp.cost.toString(),
        isPreferred: sp.isPreferred,
        notes: sp.notes,
        currentStock: totalStock,
      };
    });
  }

  /** Each supplier's current cost for a product, with its contact details. */
  async getProductSuppliers(productId: string) {
    const supplierProducts = await this.prisma.supplierProduct.findMany({
      where: { productId },
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            contactInfo: true,
            isActive: true,
          },
        },
      },
      orderBy: {
        supplier: { name: 'asc' },
      },
    });

    return supplierProducts.map((sp) => ({
      id: sp.supplier.id,
      name: sp.supplier.name,
      contactInfo: sp.supplier.contactInfo,
      isActive: sp.supplier.isActive,
      cost: sp.cost.toString(),
      isPreferred: sp.isPreferred,
      notes: sp.notes,
    }));
  }

  /** A product's cost timeline, grouped by supplier. */
  async getProductCostHistory(productId: string) {
    const costHistories = await this.prisma.supplierCostHistory.findMany({
      where: { productId },
      include: {
        supplier: {
          select: { id: true, name: true },
        },
      },
      orderBy: [
        { supplier: { name: 'asc' } },
        { effectiveAt: 'desc' },
      ],
    });

    // Group by supplier
    const groupedBySupplier = new Map<
      string,
      Array<{
        id: string;
        cost: string;
        effectiveAt: string;
        createdAt: string;
        source: string;
        isCurrent: boolean;
      }>
    >();

    for (const entry of costHistories) {
      const supplierId = entry.supplierId;
      if (!groupedBySupplier.has(supplierId)) {
        groupedBySupplier.set(supplierId, []);
      }
      groupedBySupplier.get(supplierId)!.push({
        id: entry.id,
        cost: entry.unitCost.toString(),
        effectiveAt: entry.effectiveAt.toISOString(),
        createdAt: entry.createdAt.toISOString(),
        source: entry.source,
        isCurrent: entry.isCurrent,
      });
    }

    // Convert to array format with supplier info
    return Array.from(groupedBySupplier.entries()).map(([supplierId, history]) => {
      const firstEntry = costHistories.find((e) => e.supplierId === supplierId);
      return {
        supplierId,
        supplierName: firstEntry?.supplier.name || 'Unknown',
        costHistory: history,
      };
    });
  }

  /**
   * Get single product by ID
   */
  async getProduct(productId: string, locationId?: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        category: true,
        catalogMappings: {
          orderBy: { createdAt: 'desc' },
          include: {
            location: true,
          },
        },
        inventories: locationId
          ? {
              where: { locationId },
            }
          : true,
        receivings: {
          where: locationId ? { locationId } : undefined,
          take: 10,
          orderBy: { receivedAt: 'desc' },
        },
      },
    });

    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    const mapping = preferredMapping(product.catalogMappings, locationId);
    const totalInventory = product.inventories.reduce((sum, inv) => sum + inv.quantity, 0);
    
    // Calculate average cost from inventory
    const totalCost = product.inventories.reduce(
      (sum, inv) => sum + (inv.quantity * Number(inv.unitCost)),
      0
    );
    const averageCost = totalInventory > 0 ? totalCost / totalInventory : null;

    return {
      success: true,
      data: {
        ...product,
        sellingPrice: mapping ? this.fromCents(Number(mapping.priceCents)) : null,
        currency: mapping?.currency || CURRENCY,
        totalInventory,
        averageCost,
        hasSquareSync: mapping ? isSquareMapping(mapping) : false,
      },
    };
  }

  /**
   * Link (or unlink) an already-existing box product to its already-existing
   * loose counterpart — the realistic entry point for sueltos, since Box and
   * Loose are two separate products/Square items that already exist today.
   */
  async setLooseProductLink(productId: string, looseProductId: string | null, quantity?: number) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    if (looseProductId) {
      if (looseProductId === productId) {
        throw new BadRequestException('Un producto no puede ser su propio producto suelto');
      }
      const looseProduct = await this.prisma.product.findUnique({ where: { id: looseProductId } });
      if (!looseProduct) {
        throw new NotFoundException(`Product ${looseProductId} not found`);
      }
      // Walk the loose product's own chain: reaching this product would loop
      // break-bulk. Stop at a product seen twice, a loop saved before this check.
      const seen = new Set<string>();
      for (let next = looseProduct.looseProductId; next && !seen.has(next); ) {
        if (next === productId) {
          throw new BadRequestException('El producto suelto ya lleva de vuelta a este producto');
        }
        seen.add(next);
        next = (await this.prisma.product.findUnique({ where: { id: next }, select: { looseProductId: true } }))?.looseProductId ?? null;
      }
    }
    if (quantity !== undefined && !(isWholeNumber(quantity) && quantity > 0)) {
      throw new BadRequestException('La cantidad debe ser un número entero mayor que cero');
    }

    return this.prisma.product.update({
      where: { id: productId },
      data: { looseProductId, ...(quantity !== undefined && { quantity }) },
    });
  }

  /**
   * Set (replace) a product's brand-name search tags — e.g. tagging a
   * generic with the brand names customers actually ask for, so catalog
   * search surfaces it even when no branded Product row exists at all.
   */
  async setSearchAliases(productId: string, searchAliases: string[]) {
    assertWordList(searchAliases, 'Los alias de búsqueda');
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    return this.prisma.product.update({
      where: { id: productId },
      data: { searchAliases: normalizeSearchAliases(searchAliases) },
    });
  }

  /**
   * Mark (or unmark) a product as a Yastás per-employee service item:
   * sets tracksInventory and the employeeId on every CatalogMapping row for
   * this product (mirrors scripts/set-yastas-employee-mapping.ts, keyed by
   * productId instead of a raw Square variation id). Pass employeeId: null
   * to revert the product back to normal FIFO-tracked merchandise.
   */
  async setYastasMapping(productId: string, employeeId: string | null) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    if (employeeId) {
      const employee = await this.prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) {
        throw new NotFoundException(`Employee ${employeeId} not found`);
      }
      const { _sum } = await this.prisma.inventory.aggregate({ where: { productId }, _sum: { quantity: true } });
      if ((_sum.quantity ?? 0) > 0) {
        throw new BadRequestException('Este producto tiene existencias: dales salida antes de marcarlo como servicio Yastás');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.catalogMapping.updateMany({ where: { productId }, data: { employeeId } });
      return tx.product.update({
        where: { id: productId },
        data: { tracksInventory: employeeId === null },
        include: { catalogMappings: true },
      });
    });
  }

  /** Set (replace) a category's symptom search keywords. */
  async setCategorySymptomKeywords(categoryId: string, symptomKeywords: string[]) {
    assertWordList(symptomKeywords, 'Los síntomas');
    const category = await this.prisma.category.findUnique({ where: { id: categoryId } });
    if (!category) {
      throw new NotFoundException(`Category ${categoryId} not found`);
    }

    return this.prisma.category.update({
      where: { id: categoryId },
      data: { symptomKeywords: normalizeSearchAliases(symptomKeywords) },
    });
  }
}
