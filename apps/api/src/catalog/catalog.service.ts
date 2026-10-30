import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { Square, SquareClient } from 'square';
import { createSquareClient } from '../square/square-client';

/**
 * Catalog sync result statistics
 */
export interface CatalogSyncResult {
  totalVariationsFound: number;
  variationsProcessed: number;
  productsCreated: number;
  mappingsCreated: number;
  mappingsSkipped: number;
  errors: CatalogSyncError[];
}

/**
 * Catalog sync error information
 */
export interface CatalogSyncError {
  variationId: string;
  variationName: string;
  error: string;
  skipped: boolean;
}

interface CatalogData {
  productName: string | null;
  productDescription: string | null;
  imageUrl: string | null;
  priceCents: number | null; // the variation's base price (priceMoney.amount)
  currency: string | null;
}

const NO_CATALOG_DATA: CatalogData = { productName: null, productDescription: null, imageUrl: null, priceCents: null, currency: null };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Labels that end up where a product name should be: Square's default
 * variation names, and this sync's own fallback when a variation has none.
 * Exact match on purpose — "Insulina Regular" and "Regular 500 ml" are real
 * names. Must stay in sync with the placeholder-name data migration (20261024120000).
 */
const PLACEHOLDER_NAMES = new Set(['regular', 'sin variación', 'sin variacion', 'no variation', 'unknown']);

/**
 * Price columns for a CatalogMapping write. Empty when Square gave no price
 * (e.g. the item-detail fetch failed): a resync must keep the cached price,
 * not overwrite it with null.
 */
export function mappingPriceFields(priceCents: number | null | undefined, currency: string | null | undefined) {
  if (priceCents == null || !Number.isFinite(priceCents)) return {};
  return { priceCents: new Prisma.Decimal(priceCents), currency: currency || 'USD', priceSyncedAt: new Date() };
}

/**
 * Variation -> product across mapping scopes, preferring the global mapping
 * (locationId null) over a location-scoped one.
 */
export function productByVariation<P>(mappings: { squareVariationId: string; locationId: string | null; product: P }[]) {
  const byVariation = new Map<string, P>();
  for (const m of [...mappings].sort((a, b) => Number(a.locationId !== null) - Number(b.locationId !== null))) {
    if (!byVariation.has(m.squareVariationId)) byVariation.set(m.squareVariationId, m.product);
  }
  return byVariation;
}

export function isPlaceholderProductName(name: string | null | undefined): boolean {
  return !name || PLACEHOLDER_NAMES.has(name.trim().toLowerCase());
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  private squareClient: SquareClient | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private getSquareClient(): SquareClient {
    this.squareClient ??= createSquareClient();
    if (!this.squareClient) {
      throw new Error('SQUARE_ACCESS_TOKEN environment variable is not set');
    }
    return this.squareClient;
  }

  /**
   * Name, description, image and price per variation, read in batches of 100
   * with each variation's item: the item's name, plus the variation's own name
   * when it isn't a placeholder ("Aspirina (500 mg)"). A batch Square fails to
   * return gets no data rather than failing the sync.
   */
  private async fetchBatchCatalogObjects(variationIds: string[]): Promise<Map<string, CatalogData>> {
    const client = this.getSquareClient();
    const resultMap = new Map<string, CatalogData>();
    const BATCH_SIZE = 100;

    for (let i = 0; i < variationIds.length; i += BATCH_SIZE) {
      const batch = variationIds.slice(i, i + BATCH_SIZE);
      try {
        const response = await client.catalog.batchGet({ objectIds: batch, includeRelatedObjects: true });
        const related = response.relatedObjects ?? [];

        for (const obj of response.objects ?? []) {
          if (obj.type !== 'ITEM_VARIATION') continue;
          const variationData = obj.itemVariationData;
          const variationName = variationData?.name ?? '';
          const itemData = related.find((r): r is Square.CatalogObject.Item => r.type === 'ITEM' && r.id === variationData?.itemId)?.itemData;
          const itemName = itemData?.name ?? null;
          const productName = itemName && (isPlaceholderProductName(variationName) ? itemName : `${itemName} (${variationName})`);

          // The variation's own photo first, then the item's.
          const imageId = [...(variationData?.imageIds ?? []), ...(itemData?.imageIds ?? [])][0];
          const image = related.find((r): r is Square.CatalogObject.Image => r.type === 'IMAGE' && r.id === imageId);

          const amount = variationData?.priceMoney?.amount;
          const priceCents = amount == null || amount < 0 ? null : Number(amount);

          resultMap.set(obj.id, {
            productName,
            productDescription: itemData?.description ?? null,
            imageUrl: image?.imageData?.url ?? null,
            priceCents,
            currency: variationData?.priceMoney?.currency ?? null,
          });
        }
      } catch (error) {
        this.logger.warn(`[CATALOG_SYNC] Failed to fetch batch: ${batch.join(', ')}`, error);
        for (const id of batch) if (!resultMap.has(id)) resultMap.set(id, NO_CATALOG_DATA);
      }
    }

    return resultMap;
  }

  /**
   * Catalog sync is for the migration (the owner's rule): once a store has cut
   * over, products are created in the app, which creates their Square item and
   * mapping itself. Refuses a store that has cut over, and every store once any has.
   */
  private async assertBeforeCutover(locationId: string | null): Promise<void> {
    const lock = await this.prisma.cutoverLock.findFirst({
      where: locationId ? { isLocked: true, OR: [{ locationId }, { locationId: null }] } : { isLocked: true },
    });
    if (lock) {
      throw new BadRequestException(
        locationId
          ? 'La sincronización del catálogo es solo para la migración: esta sucursal ya hizo su corte.'
          : 'La sincronización del catálogo es solo para la migración: ya hay sucursales con corte.',
      );
    }
  }

  /**
   * Maps every Square variation to a product, creating the product when no
   * mapping or SKU finds one, for one store (locationId) or globally. Skips
   * archived items and Yastás items, whose mapping carries the employee the
   * worker needs; a store mapping without it would take priority and fail every sale.
   */
  async syncSquareCatalog(locationId: string | null, forceResync: boolean): Promise<CatalogSyncResult> {
    const client = this.getSquareClient();

    if (locationId) {
      const location = await this.prisma.location.findUnique({ where: { id: locationId } });
      if (!location) throw new BadRequestException('Sucursal no encontrada');
      this.logger.log(`[CATALOG_SYNC] Syncing for location: ${location.name} (${locationId})`);
    } else {
      this.logger.log(`[CATALOG_SYNC] Syncing globally (no location specified)`);
    }
    await this.assertBeforeCutover(locationId);

    // 1. Every variation, with their items (to see which are archived).
    const variations: Square.CatalogObject.ItemVariation[] = [];
    const archivedItemIds = new Set<string>();
    let cursor: string | undefined;
    try {
      do {
        const response = await client.catalog.search({ objectTypes: ['ITEM_VARIATION'], includeRelatedObjects: true, cursor });
        for (const o of response.objects ?? []) if (o.type === 'ITEM_VARIATION') variations.push(o);
        for (const o of response.relatedObjects ?? []) if (o.type === 'ITEM' && o.itemData?.isArchived) archivedItemIds.add(o.id);
        cursor = response.cursor || undefined;
      } while (cursor);
    } catch (error) {
      this.logger.error('[CATALOG_SYNC] Square API error:', error);
      throw new Error(`Failed to fetch catalog: ${error}`);
    }

    const result: CatalogSyncResult = {
      totalVariationsFound: variations.length,
      variationsProcessed: 0,
      productsCreated: 0,
      mappingsCreated: 0,
      mappingsSkipped: 0,
      errors: [],
    };
    this.logger.log(`[CATALOG_SYNC] Found ${variations.length} variations. Starting sync...`);

    // 2. What the app already has.
    const variationIds = variations.map((v) => v.id);
    const existingMappings = await this.prisma.catalogMapping.findMany({
      where: { squareVariationId: { in: variationIds }, locationId },
      include: { product: true },
    });
    const mappingMap = new Map(existingMappings.map((m) => [m.squareVariationId, m]));

    // The same variation mapped in any scope (global, or another location)
    // already has its product. Without this, a location sync found no mapping
    // for that location and, for a SKU-less variation, created a duplicate.
    // Unfiltered by scope on purpose: the in-scope mapping is checked first.
    const anyScopeMappings = await this.prisma.catalogMapping.findMany({
      where: { squareVariationId: { in: variationIds } },
      include: { product: true },
    });
    const anyScopeProductMap = productByVariation(anyScopeMappings);
    const yastasVariationIds = new Set(anyScopeMappings.filter((m) => m.employeeId).map((m) => m.squareVariationId));

    const skus = variations.map((v) => v.itemVariationData?.sku).filter((sku): sku is string => !!sku);
    const productsBySku = skus.length > 0 ? await this.prisma.product.findMany({ where: { sku: { in: skus } } }) : [];
    const productBySkuMap = new Map(productsBySku.map((p) => [p.sku!, p]));

    const getCachedProduct = (varId: string, sku: string | null) =>
      mappingMap.get(varId)?.product ?? anyScopeProductMap.get(varId) ?? (sku ? productBySkuMap.get(sku) : undefined) ?? null;

    // 3. Which variations this sync writes, and of those, which need Square's details.
    const toSync = variations.filter((v) => {
      const archived = !!v.itemVariationData?.itemId && archivedItemIds.has(v.itemVariationData.itemId);
      // A Yastás item keeps its employee's mapping; another without the employee would take priority.
      const yastas = yastasVariationIds.has(v.id) && !mappingMap.has(v.id);
      const upToDate = mappingMap.has(v.id) && !forceResync;
      if (archived || yastas || upToDate) result.mappingsSkipped++;
      return !archived && !yastas && !upToDate;
    });
    const variationsNeedingFetch = toSync
      .filter((v) => {
        const synced = getCachedProduct(v.id, v.itemVariationData?.sku ?? null)?.squareDataSyncedAt;
        return forceResync || !synced || Date.now() - synced.getTime() > DAY_MS;
      })
      .map((v) => v.id);

    this.logger.log(`[CATALOG_SYNC] Fetching details for ${variationsNeedingFetch.length} items...`);
    const catalogDataMap = variationsNeedingFetch.length > 0 ? await this.fetchBatchCatalogObjects(variationsNeedingFetch) : new Map<string, CatalogData>();

    // 4. Write 20 at a time: fast without exhausting the connection pool.
    const CHUNK_SIZE = 20;
    for (let i = 0; i < toSync.length; i += CHUNK_SIZE) {
      await Promise.all(
        toSync.slice(i, i + CHUNK_SIZE).map(async (variation) => {
          try {
            await this.syncVariation(variation, { locationId, forceResync, existingMapping: mappingMap.get(variation.id), catalogDataMap, getCachedProduct, productBySkuMap, result });
            result.variationsProcessed++;
          } catch (error) {
            result.errors.push({
              variationId: variation.id,
              variationName: variation.itemVariationData?.name || 'Unknown',
              error: error instanceof Error ? error.message : String(error),
              skipped: true,
            });
          }
        }),
      );
    }

    return result;
  }

  /** One variation's product and mapping, written together. */
  private async syncVariation(
    variation: Square.CatalogObject.ItemVariation,
    ctx: {
      locationId: string | null;
      forceResync: boolean;
      existingMapping: { id: string } | undefined;
      catalogDataMap: Map<string, CatalogData>;
      getCachedProduct: (varId: string, sku: string | null) => Prisma.ProductGetPayload<object> | null;
      productBySkuMap: Map<string, Prisma.ProductGetPayload<object>>;
      result: CatalogSyncResult;
    },
  ): Promise<void> {
    const { locationId, forceResync, existingMapping, catalogDataMap, result } = ctx;
    const variationId = variation.id;
    const variationName = variation.itemVariationData?.name || 'Unknown';
    const variationSku = variation.itemVariationData?.sku || null;
    let product = ctx.getCachedProduct(variationId, variationSku);

    const fetched = catalogDataMap.get(variationId);
    const catalogData: CatalogData =
      fetched ??
      (product
        ? { ...NO_CATALOG_DATA, productName: product.squareProductName, productDescription: product.squareDescription, imageUrl: product.squareImageUrl }
        : NO_CATALOG_DATA);
    // Never a placeholder label ("Sin variación"/"Regular") as the Square name.
    const squareProductName = catalogData.productName || (isPlaceholderProductName(variationName) ? null : variationName);

    const write = () =>
      this.prisma.$transaction(async (tx) => {
        if (!product) {
          product = await tx.product.create({
            data: {
              // The item name, not the variation label; a placeholder here is repaired by a later sync.
              name: squareProductName ?? variationName,
              sku: variationSku,
              squareProductName,
              squareDescription: catalogData.productDescription,
              squareImageUrl: catalogData.imageUrl,
              squareVariationName: variationName,
              squareDataSyncedAt: new Date(),
            },
          });
          result.productsCreated++;
        } else if (forceResync || fetched) {
          product = await tx.product.update({
            where: { id: product.id },
            data: {
              // Repair a name still stuck on a placeholder label; never touch a real one.
              ...(squareProductName && isPlaceholderProductName(product.name) ? { name: squareProductName } : {}),
              squareProductName,
              squareDescription: catalogData.productDescription,
              squareImageUrl: catalogData.imageUrl,
              squareVariationName: variationName,
              squareDataSyncedAt: new Date(),
            },
          });
        }

        const priceData = mappingPriceFields(catalogData.priceCents, catalogData.currency);
        if (existingMapping) {
          await tx.catalogMapping.update({ where: { id: existingMapping.id }, data: { syncedAt: new Date(), ...priceData } });
        } else {
          await tx.catalogMapping.create({
            data: { squareVariationId: variationId, productId: product!.id, locationId, syncedAt: new Date(), ...priceData },
          });
          result.mappingsCreated++;
        }
      });

    try {
      await write();
    } catch (error) {
      // Another variation with this SKU created its product meanwhile. Postgres
      // aborted that transaction, so look it up outside it and map to it.
      if ((error as { code?: string }).code !== 'P2002' || !variationSku || product) throw error;
      product = await this.prisma.product.findUnique({ where: { sku: variationSku } });
      if (!product) throw error;
      await write();
    }
    if (product?.sku) ctx.productBySkuMap.set(product.sku, product);
  }
}
