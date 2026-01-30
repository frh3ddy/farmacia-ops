import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  CutoverInput,
  CostExtractionResult,
  CostApprovalRequest,
  OpeningBalanceItem,
  MigrationResult,
  MigrationError,
  MigrationWarning,
  CutoverLock,
  LocationPreview,
  ProductPreview,
  ItemToProcess,
} from './types';
import {
  MigrationError as MigrationErrorClass,
  CutoverValidationError,
} from './errors';
import { SquareInventoryService } from './square-inventory.service';
import { CostExtractionService } from './cost-extraction.service';
import { CatalogMapperService } from './catalog-mapper.service';
import { SupplierService } from './supplier.service';

@Injectable()
export class InventoryMigrationService {
  private readonly logger = new Logger(InventoryMigrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly squareInventory: SquareInventoryService,
    private readonly costExtraction: CostExtractionService,
    private readonly catalogMapper: CatalogMapperService,
    private readonly supplierService: SupplierService,
  ) {}

  /**
   * Helper: Normalize product names (Centralized logic)
   */
  private normalizeSquareProductName(
    productName: string | null,
    variationName: string | null,
    fallbackName: string
  ): string {
    const cleanSquareName = productName && 
      !productName.toLowerCase().includes('sin variación') && 
      !productName.toLowerCase().includes('no variation') &&
      productName.trim().length > 0 
      ? productName 
      : null;

    const cleanVarName = variationName && 
      !variationName.toLowerCase().includes('sin variación') && 
      !variationName.toLowerCase().includes('no variation') &&
      variationName.trim().length > 0 
      ? variationName 
      : null;

    return cleanSquareName || cleanVarName || fallbackName;
  }

  private buildPriceGuard(
    sellingPrice: { priceCents: number; currency: string } | null,
    selectedCost: number | null | undefined,
  ) {
    if (!sellingPrice) {
      return {
        hasSellingPrice: false,
        isCostTooHigh: false,
        message: 'No Square selling price found for this product/variation.',
      };
    }

    const minSellingPriceCents = sellingPrice.priceCents;

    if (selectedCost === null || selectedCost === undefined) {
      return {
        hasSellingPrice: true,
        minSellingPriceCents,
        isCostTooHigh: false,
        message: null,
      };
    }

    const selectedCostCents = Math.round(selectedCost * 100);
    const isCostTooHigh = selectedCostCents >= minSellingPriceCents;

    return {
      hasSellingPrice: true,
      minSellingPriceCents,
      selectedCostCents,
      isCostTooHigh,
      message: isCostTooHigh
        ? `Selected cost (${selectedCostCents} cents) is >= MIN selling price (${minSellingPriceCents} cents).`
        : null,
    };
  }

  /**
   * Validate cutover input parameters before migration
   */
  async validateCutoverInput(input: CutoverInput): Promise<{
    valid: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];

    if (input.cutoverDate > new Date()) errors.push('Cutover date cannot be in the future');
    if (!input.ownerApproved) errors.push('Cutover must be explicitly approved by owner');
    if (input.locationIds.length === 0) errors.push('At least one location must be specified');

    // Optimization: Parallel location validation
    const locationChecks = await Promise.all(
      input.locationIds.map(async (id) => {
        const loc = await this.prisma.location.findUnique({ where: { id }, select: { id: true } });
        return { id, exists: !!loc };
      })
    );

    locationChecks.forEach(check => {
      if (!check.exists) errors.push(`Location ${check.id} does not exist`);
    });

    const validCostBases = ['SQUARE_COST', 'DESCRIPTION', 'MANUAL_INPUT', 'AVERAGE_COST'];
    if (!validCostBases.includes(input.costBasis)) {
      errors.push(`Invalid cost basis: ${input.costBasis}`);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Extract costs from all products for migration preview and approval
   * OPTIMIZED: Bulk pre-fetching and improved resume logic with caching
   */
  async extractCostsForMigration(
    locationIds: string[],
    costBasis: 'DESCRIPTION',
    batchSize?: number | null,
    extractionSessionId?: string | null,
    newBatchSize?: number | null,
    recursionDepth: number = 0,
    cachedItems?: ItemToProcess[]
  ): Promise<CostApprovalRequest> {
    const sessionId = extractionSessionId || this.generateUUID();
    let dbSession = await this.prisma.extractionSession.findUnique({ where: { id: sessionId } });

    // 1) Collect inventory items across selected locations
    let allItems: ItemToProcess[] = cachedItems || [];
    
    if (allItems.length === 0) {
      for (const locationId of locationIds) {
        const location = await this.prisma.location.findUnique({ where: { id: locationId } });
        if (!location?.squareId) continue;

        const items = await this.squareInventory.fetchSquareInventory(location.squareId);
        for (const item of items) {
          allItems.push({
            locationId,
            locationName: location.name,
            squareInventoryItem: item,
            itemKey: `${locationId}:${item.catalogObjectId}`,
          });
        }
      }
    }

    // 2) Create session if not exists
    if (!dbSession) {
      const eff = batchSize && batchSize > 0 ? batchSize : allItems.length;
      dbSession = await this.prisma.extractionSession.create({
        data: {
          id: sessionId,
          cutoverId: sessionId,
          locationIds,
          currentBatch: 1,
          totalBatches: Math.ceil(allItems.length / eff),
          totalItems: allItems.length,
          processedItems: 0,
          batchSize: eff,
          status: 'IN_PROGRESS',
        },
      });
    }

    // 3) Apply new batch size if requested
    let effectiveBatchSize = dbSession.batchSize;
    if (newBatchSize && newBatchSize > 0) {
      effectiveBatchSize = newBatchSize;
      const remainingItems = dbSession.totalItems - dbSession.processedItems;
      const newTotalBatches = Math.ceil(remainingItems / effectiveBatchSize);
      const newCurrentBatch = dbSession.processedItems > 0 ? Math.ceil(dbSession.processedItems / effectiveBatchSize) : 1;

      await this.prisma.extractionSession.update({
        where: { id: sessionId },
        data: { batchSize: effectiveBatchSize, totalBatches: newTotalBatches, currentBatch: newCurrentBatch },
      });
      dbSession.batchSize = effectiveBatchSize;
      dbSession.totalBatches = newTotalBatches;
      dbSession.currentBatch = newCurrentBatch;
    }

    // 4) Figure out SKIPPED productIds for this session
    const skippedProductIds = new Set<string>();
    {
      const skippedApprovals = await this.prisma.costApproval.findMany({
        where: {
          cutoverId: dbSession.cutoverId || sessionId,
          migrationStatus: 'SKIPPED',
        },
        select: { productId: true },
      });
      skippedApprovals.forEach((a) => skippedProductIds.add(a.productId));
    }

    // 5) Resolve products for this page of inventory items
    const startIndex = (dbSession.currentBatch - 1) * effectiveBatchSize;
    const pageItems = allItems.slice(startIndex, startIndex + effectiveBatchSize);

    // OPTIMIZATION: Use batchResolveProductsFromSquareVariations
    const catalogObjectIds = pageItems.map(item => item.squareInventoryItem.catalogObjectId);
    // Note: We have items from multiple locations, but batchResolve expects a single location or logic is slightly different.
    // However, the items loop below processes pageItems, which might be mixed locations.
    // batchResolveProductsFromSquareVariations takes locationId.
    // If we have mixed locations, we should probably do it per location or group by location.
    
    // Group page items by location for resolution
    const itemsByLocation = new Map<string, string[]>();
    for (const item of pageItems) {
      if (!itemsByLocation.has(item.locationId)) itemsByLocation.set(item.locationId, []);
      itemsByLocation.get(item.locationId)!.push(item.squareInventoryItem.catalogObjectId);
    }

    const variationToProductMap = new Map<string, string>();
    for (const [locId, vars] of itemsByLocation) {
       const map = await this.catalogMapper.batchResolveProductsFromSquareVariations(vars, locId);
       map.forEach((pid, vid) => variationToProductMap.set(vid, pid));
    }

    const resolvedItems = pageItems.map(item => {
        const pid = variationToProductMap.get(item.squareInventoryItem.catalogObjectId);
        // If not resolved, we might want to skip or handle error, but original logic threw or returned something.
        // Original logic: "resolveProductFromSquareVariation" throws UnmappedProductError if not found.
        // My batch resolve filters them out.
        // If pid is missing, we can filter it out in the next step.
        return { ...item, productId: pid };
    });

    // Filter out skipped products and unresolved products
    const nonSkipped = resolvedItems.filter((i) => i.productId && !skippedProductIds.has(i.productId)) as (ItemToProcess & { productId: string })[];

    // 6) Dedup by productId (ONE result per product)
    // Representative item used to fetch Square catalog data
    const representativeByProduct = new Map<string, (typeof nonSkipped)[0]>();
    const variationIdsByProduct = new Map<string, Set<string>>();

    for (const item of nonSkipped) {
      if (!representativeByProduct.has(item.productId)) {
        representativeByProduct.set(item.productId, item);
      }
      if (!variationIdsByProduct.has(item.productId)) {
        variationIdsByProduct.set(item.productId, new Set());
      }
      variationIdsByProduct.get(item.productId)!.add(item.squareInventoryItem.catalogObjectId);
    }

    const batchProductIds = Array.from(representativeByProduct.keys());

    // 7) Bulk load products and approvals
    const [products, approvals] = await Promise.all([
      this.prisma.product.findMany({
        where: { id: { in: batchProductIds } },
        select: {
          id: true,
          name: true,
          squareProductName: true,
          squareDescription: true,
          squareImageUrl: true,
          squareVariationName: true,
        },
      }),
      // NOTE: If you want approvals strictly per session, add cutoverId filter.
      this.prisma.costApproval.findMany({
        where: { productId: { in: batchProductIds } },
        orderBy: { approvedAt: 'desc' },
        select: {
          id: true,
          productId: true,
          cutoverId: true,
          migrationStatus: true,
          approvedCost: true,
          source: true,
          notes: true,
          approvedAt: true,
          approvedBy: true,
          sellingPriceCents: true,
          sellingPriceCurrency: true,
          sellingPriceRangeMinCents: true,
          sellingPriceRangeMaxCents: true,
        },
      }),
    ]);

    const productMap = new Map(products.map((p) => [p.id, p]));
    const approvalMap = new Map<string, any>();
    approvals.forEach((a) => {
      if (!approvalMap.has(a.productId)) approvalMap.set(a.productId, a);
    });

    // 8) Load cached prices from CatalogMapping first
    const allVariationIds = new Set<string>();
    for (const set of variationIdsByProduct.values()) {
      for (const v of set) allVariationIds.add(v);
    }

    const variationIds = Array.from(allVariationIds);
    const cachedMappings = await this.prisma.catalogMapping.findMany({
      where: {
        squareVariationId: { in: variationIds },
      },
      select: {
        squareVariationId: true,
        priceCents: true,
        currency: true,
        priceSyncedAt: true,
      } as any, 
    });

    const cachedPriceMap = new Map(
      cachedMappings.map((m: any) => [
        m.squareVariationId,
        {
          priceCents: m.priceCents,
          currency: m.currency,
          priceSyncedAt: m.priceSyncedAt,
        },
      ]),
    );

    // Debug: Log cache status
    const withPrice = cachedMappings.filter((m: any) => m.priceCents !== null).length;
    const withSyncDate = cachedMappings.filter((m: any) => m.priceSyncedAt !== null).length;
    this.logger.log(`[EXTRACTION] Found ${cachedMappings.length} catalog mappings for ${variationIds.length} variations (${withPrice} with price, ${withSyncDate} with sync date)`);

    // 9) Identify variations needing Square fetch (missing or stale prices)
    const PRICE_STALE_HOURS = 24;
    const now = new Date();
    const variationsNeedingFetch = new Set<string>();

    for (const vid of variationIds) {
      const cached = cachedPriceMap.get(vid);
      const isStale =
        !cached ||
        !cached.priceCents ||
        !cached.priceSyncedAt ||
        now.getTime() - cached.priceSyncedAt.getTime() > PRICE_STALE_HOURS * 60 * 60 * 1000;

      if (isStale) {
        variationsNeedingFetch.add(vid);
      }
    }

    // 10) Fetch only missing/stale prices from Square
    const catalogDataMap = new Map<string, any>();
    if (variationsNeedingFetch.size > 0) {
      this.logger.log(
        `[EXTRACTION] Fetching ${variationsNeedingFetch.size} prices from Square (${variationIds.length - variationsNeedingFetch.size} from cache)`,
      );
      
      const fetchIds = Array.from(variationsNeedingFetch);
      
      // OPTIMIZATION: Use batchFetchSquareCatalogObjects
      try {
        const batchResults = await this.squareInventory.batchFetchSquareCatalogObjects(fetchIds);
        
        // Collect price updates for batch processing
        const priceUpdates: Array<{ vid: string; priceCents: number; currency: string }> = [];
        
        for (const [vid, data] of batchResults) {
            catalogDataMap.set(vid, data);
            
            const priceCents = data.variationPriceCents;
            const currency = data.variationCurrency;
            if (priceCents !== null && priceCents !== undefined && currency) {
              priceUpdates.push({ vid, priceCents, currency });
            }
        }
        
        // Batch update CatalogMapping prices (blocking to ensure cache is populated)
        if (priceUpdates.length > 0) {
          try {
            await Promise.all(
              priceUpdates.map(({ vid, priceCents, currency }) =>
                this.prisma.catalogMapping.updateMany({
                  where: { squareVariationId: vid },
                  data: {
                    priceCents: new Prisma.Decimal(priceCents),
                    currency: currency,
                    priceSyncedAt: new Date(),
                  } as any,
                })
              )
            );
            this.logger.log(`[EXTRACTION] Updated ${priceUpdates.length} prices in cache`);
          } catch (e) {
            this.logger.warn(`[PRICE_CACHE_UPDATE] Failed to update price cache:`, e);
          }
        }
      } catch (e) {
          this.logger.warn(`[CATALOG_FETCH_ERROR] Failed to batch fetch variations:`, e);
      }
    } else {
      this.logger.log(`[EXTRACTION] All ${variationIds.length} prices loaded from cache`);
    }

    // 11) Build selling price list per product (from cache + fresh Square data)
    const sellingPricesByProduct = new Map<
      string,
      Array<{ variationId: string; variationName?: string | null; priceCents: number; currency: string }>
    >();

    for (const [productId, vset] of variationIdsByProduct.entries()) {
      const list: Array<{ variationId: string; variationName?: string | null; priceCents: number; currency: string }> = [];
      for (const vid of vset.values()) {
        let priceCents: number | null = null;
        let currency: string | null = null;
        let variationName: string | null = null;

        // Try cached price first
        const cached = cachedPriceMap.get(vid);
        if (cached?.priceCents && cached?.currency) {
          priceCents = cached.priceCents.toNumber();
          currency = cached.currency;
        }

        // Always check fresh Square data for variation name and as fallback for price
        const cat = catalogDataMap.get(vid);
        if (cat) {
          if (!priceCents) priceCents = cat.variationPriceCents;
          if (!currency) currency = cat.variationCurrency;
          // Always get variation name from Square if available (even if price is cached)
          variationName = cat.itemVariationData?.name ?? null;
        }

        if (!Number.isFinite(priceCents) || priceCents === null || !currency) continue;

        list.push({
          variationId: vid,
          variationName: variationName,
          priceCents,
          currency,
        });
      }
      // de-dupe by variationId
      const uniq = new Map(list.map((x) => [x.variationId, x]));
      sellingPricesByProduct.set(productId, Array.from(uniq.values()));
    }

    // 10) Assemble CostExtractionResult per productId
    const extractionResults: CostExtractionResult[] = [];
    let productsWithExtraction = 0;
    let productsRequiringManualInput = 0;

    for (const productId of batchProductIds) {
      const product = productMap.get(productId);
      if (!product) continue;

      const rep = representativeByProduct.get(productId)!;
      const existingApproval = approvalMap.get(productId);

      // Use representative variation to fetch catalog name/desc/image
      const repVarId = rep.squareInventoryItem.catalogObjectId;
      
      // Ensure we have catalog data for representative item if it wasn't fetched in step 10
      // (Step 10 only fetched stale prices. We might need name/image even if price was cached)
      // If we don't have it, we should probably fetch it, but to keep batch speed, we rely on DB values if missing.
      // OPTIMIZATION: If we really want it, we should have included it in step 9's "needing fetch" logic 
      // if metadata was missing. For now, we assume best effort.
      
      const repCat = catalogDataMap.get(repVarId);

      let productName = product.squareProductName || product.squareVariationName || product.name;
      let productDescription = product.squareDescription || null;
      let imageUrl = product.squareImageUrl || null;

      if (repCat) {
        const normalizedName = this.normalizeSquareProductName(
          repCat.productName,
          repCat.itemVariationData?.name,
          productName,
        );

        productName = normalizedName;
        productDescription = repCat.productDescription || productDescription;
        imageUrl = repCat.imageUrl || imageUrl;

        // Cache Square metadata in background (best-effort)
        this.prisma.product
          .update({
            where: { id: productId },
            data: {
              squareProductName: normalizedName,
              squareDescription: productDescription,
              squareImageUrl: imageUrl,
              squareVariationName: repCat.itemVariationData?.name,
              squareDataSyncedAt: new Date(),
            },
          })
          .catch((e) => this.logger.warn(`Failed to update product ${productId}: ${e}`));
      }

      const sellingPrices = sellingPricesByProduct.get(productId) || [];
      let sellingPrice: { priceCents: number; currency: string } | null = null;
      let sellingPriceRange: { minCents: number; maxCents: number; currency: string } | null = null;

      if (sellingPrices.length > 0) {
        const currency = sellingPrices[0].currency;
        const cents = sellingPrices.map((p) => p.priceCents);
        const minCents = Math.min(...cents);
        const maxCents = Math.max(...cents);
        sellingPrice = { priceCents: minCents, currency };
        if (minCents !== maxCents) sellingPriceRange = { minCents, maxCents, currency };
      }

      if (existingApproval) {
        let supplierName = null;
        if (existingApproval.notes) {
          const match = existingApproval.notes.match(/Supplier:\s*(.+)/i);
          if (match?.[1]) supplierName = match[1].trim();
        }

        const selectedCost = existingApproval.approvedCost.toNumber();
        const guard = this.buildPriceGuard(sellingPrice, selectedCost);

        extractionResults.push({
          productId,
          productName,
          originalDescription: productName,
          extractedEntries: [],
          selectedCost,
          selectedSupplierName: supplierName,
          extractionErrors: [],
          requiresManualReview: guard.isCostTooHigh ? true : false,
          isAlreadyApproved: true,
          existingApprovedCost: existingApproval.approvedCost,
          existingApprovalDate: existingApproval.approvedAt,
          existingCutoverId: existingApproval.cutoverId,
          imageUrl,
          migrationStatus: (existingApproval as any).migrationStatus || 'PENDING',

          sellingPrices,
          sellingPrice,
          sellingPriceRange,
          priceGuard: guard,
        });
      } else {
        const extraction = this.costExtraction.extractCostFromDescription(productName, productDescription);

        const enrichedEntries = await Promise.all(
          extraction.extractedEntries.map(async (entry, idx) => {
            const inferred = this.inferSupplierNameFromInitials(entry.supplier, (dbSession!.learnedSupplierInitials as any) || {});
            const term = inferred || entry.supplier;
            const suggestions = await this.supplierService.suggestSuppliers(term, 1);
            const defaultDateString = new Date().toISOString().split('T')[0];

            return {
              ...entry,
              supplierId: suggestions.find((s) => s.name.toLowerCase() === term.toLowerCase())?.id || null,
              isEditable: true,
              suggestedSuppliers: suggestions,
              addToHistory: true,
              editedSupplierName: null,
              editedCost: null,
              editedEffectiveDate: defaultDateString,
              isSelected: idx === extraction.extractedEntries.length - 1,
            };
          }),
        );

        const guard = this.buildPriceGuard(sellingPrice, extraction.selectedCost);

        extractionResults.push({
          ...extraction,
          productId,
          productName,
          originalDescription: productName,
          extractedEntries: enrichedEntries,
          imageUrl,
          migrationStatus: 'PENDING' as const,
          requiresManualReview: extraction.requiresManualReview || guard.isCostTooHigh,

          sellingPrices,
          sellingPrice,
          sellingPriceRange,
          priceGuard: guard,
        });

        if (extraction.extractedEntries.length > 0) productsWithExtraction++;
        else productsRequiringManualInput++;
      }
    }

    // 11) Auto-advance batch if everything in current page is already processed
    const allItemsProcessed =
      extractionResults.length > 0 &&
      extractionResults.every(
        (r) => r.migrationStatus === 'APPROVED' || r.migrationStatus === 'SKIPPED' || r.isAlreadyApproved === true,
      );

    if (
      allItemsProcessed &&
      dbSession &&
      recursionDepth < 10 &&
      (dbSession.totalBatches === null || dbSession.currentBatch < dbSession.totalBatches)
    ) {
      const nextBatch = dbSession.currentBatch + 1;
      await this.prisma.extractionSession.update({
        where: { id: sessionId },
        data: {
          currentBatch: nextBatch,
          status:
            dbSession.totalBatches !== null && nextBatch >= dbSession.totalBatches
              ? 'COMPLETED'
              : 'IN_PROGRESS',
        },
      });
      dbSession.currentBatch = nextBatch;

      return this.extractCostsForMigration(
        locationIds,
        costBasis,
        null,
        sessionId,
        null,
        recursionDepth + 1,
      );
    }

    // 12) Create / reuse extraction batch record for this batch number
    const existingBatch = await this.prisma.extractionBatch.findFirst({
      where: {
        extractionSessionId: sessionId,
        batchNumber: dbSession.currentBatch,
      },
    });

    if (!existingBatch) {
      await this.prisma.$transaction([
        this.prisma.extractionBatch.create({
          data: {
            extractionSessionId: sessionId,
            cutoverId: dbSession.cutoverId || sessionId,
            batchNumber: dbSession.currentBatch,
            locationIds,
            productIds: batchProductIds,
            totalProducts: extractionResults.length,
            productsWithExtraction: productsWithExtraction,
            productsRequiringManualInput: productsRequiringManualInput,
            status: 'EXTRACTED',
          },
        }),
        this.prisma.extractionSession.update({
          where: { id: sessionId },
          data: {
            status:
              dbSession.totalBatches !== null && dbSession.currentBatch >= dbSession.totalBatches
                ? 'COMPLETED'
                : 'IN_PROGRESS',
          },
        }),
      ]);
    }

    return {
      cutoverId: sessionId,
      locationIds,
      costBasis,
      extractionResults,
      totalProducts: extractionResults.length,
      productsWithExtraction: productsWithExtraction,
      productsRequiringManualInput: productsRequiringManualInput,
      batchSize: effectiveBatchSize,
      currentBatch: dbSession.currentBatch,
      totalBatches: dbSession.totalBatches ?? null,
      processedItems: dbSession.processedItems,
      totalItems: dbSession.totalItems,
      isComplete: dbSession.totalBatches !== null && dbSession.currentBatch >= dbSession.totalBatches,
      canContinue: dbSession.totalBatches === null || dbSession.currentBatch < dbSession.totalBatches,
      extractionSessionId: sessionId,
    };
  }

  // Helper for determineUnitCost (Unchanged logic, just ensure no N+1 calls if possible)
  // ... (keeping determineUnitCost as is, but it's called inside the loop in executeInventoryMigration. 
  // We will optimize the CALLER instead of this function).

  /**
   * Main migration function
   * OPTIMIZED: Separated API calls from Transaction
   */
  async executeInventoryMigration(
    input: CutoverInput,
    approvedCosts: { productId: string; cost: Prisma.Decimal }[],
    batchSize?: number | null,
    cutoverId?: string | null,
  ): Promise<MigrationResult> {
    // 1. Validation & Setup
    const validation = await this.validateCutoverInput(input);
    if (!validation.valid) throw new CutoverValidationError('Validation failed', validation.errors);

    const approvedCostsMap = new Map(approvedCosts.map(ac => [ac.productId, ac.cost]));

    let cutoverRecord = cutoverId 
      ? await this.prisma.cutover.findUnique({ where: { id: cutoverId } })
      : await this.prisma.cutover.create({
          data: {
            cutoverDate: input.cutoverDate,
            costBasis: input.costBasis,
            ownerApproved: input.ownerApproved,
            ownerApprovedAt: input.ownerApprovedAt || new Date(),
            ownerApprovedBy: input.ownerApprovedBy || null,
            status: 'PENDING',
            batchSize: batchSize || null,
            currentBatch: 0,
            processedItems: 0,
            batchState: {
              locationIds: input.locationIds,
            } as any
          }
        });

    if (!cutoverRecord) throw new CutoverValidationError('Cutover not found', []);
    if (cutoverRecord.status === 'COMPLETED') throw new CutoverValidationError('Cutover already completed', []);

    // 2. Get SKIPPED product IDs to exclude from migration
      const skippedApprovals = await this.prisma.costApproval.findMany({
        where: {
          cutoverId: cutoverRecord.id,
          migrationStatus: 'SKIPPED',
        },
        select: { productId: true },
      });
    const skippedProductIds = new Set(skippedApprovals.map(a => a.productId));

    // 2. Fetch Square Inventory (Cached/Snapshot)
    // Optimization: Don't fetch everything if we are deep in batches. 
    // Ideally, we'd persist the square snapshot. 
    // For now, we fetch, but we optimize the loop.
    const itemsToProcess: any[] = [];
    // We assume processedProductIds tracks what we've done.
    // For large datasets, persisting `itemsToProcess` to a temp table is better, 
    // but assuming reasonable inventory (<10k), memory is fine.
    
    for (const locationId of input.locationIds) {
      const location = await this.prisma.location.findUnique({ where: { id: locationId } });
      if (!location?.squareId) continue;
      
      const inventory = await this.squareInventory.fetchSquareInventory(location.squareId);
      inventory.forEach(item => itemsToProcess.push({ locationId, squareInventoryItem: item }));
    }

    // 3. Determine Batch
    if (!cutoverRecord.totalItems) {
      await this.prisma.cutover.update({
         where: { id: cutoverRecord.id }, 
         data: { totalItems: itemsToProcess.length } 
      });
    }

    const effectiveBatchSize = batchSize || itemsToProcess.length;
    const currentBatch = cutoverRecord.currentBatch || 0;
    const start = currentBatch * effectiveBatchSize;
    const batchItems = itemsToProcess.slice(start, start + effectiveBatchSize);

    // Initial Result Object
    const result: MigrationResult = {
      cutoverId: cutoverRecord.id,
      cutoverDate: input.cutoverDate,
      locationsProcessed: 0,
      productsProcessed: cutoverRecord.processedItems || 0,
      openingBalancesCreated: 0,
      errors: [],
      warnings: [],
      completedAt: new Date(),
      completedBy: input.ownerApprovedBy || null,
      batchSize: effectiveBatchSize,
      currentBatch,
      totalBatches: Math.ceil(itemsToProcess.length / effectiveBatchSize),
      processedItems: cutoverRecord.processedItems || 0,
      totalItems: itemsToProcess.length,
      skippedItems: skippedProductIds.size,
      isComplete: false,
      canContinue: false,
    };

    if (batchItems.length === 0) {
      // Finalize
      await this.prisma.cutover.update({
        where: { id: cutoverRecord.id },
        data: { status: 'COMPLETED', completedAt: new Date(), result: result as any }
      });
      await this.enableCutoverLock(input.cutoverDate, input.locationIds, this.prisma);
      result.isComplete = true;
      return result;
    }

    // 4. PRE-FETCH DATA (Avoid API/DB in transaction)
    
    // A. Resolve Product IDs
    // OPTIMIZATION: Use batchResolveProductsFromSquareVariations
    const itemsByLocation = new Map<string, string[]>();
    for (const item of batchItems) {
      if (!itemsByLocation.has(item.locationId)) itemsByLocation.set(item.locationId, []);
      itemsByLocation.get(item.locationId)!.push(item.squareInventoryItem.catalogObjectId);
    }
    
    const variationToProductMap = new Map<string, string>();
    for (const [locId, vars] of itemsByLocation) {
       const map = await this.catalogMapper.batchResolveProductsFromSquareVariations(vars, locId);
       map.forEach((pid, vid) => variationToProductMap.set(vid, pid));
    }

    const resolvedBatch = batchItems.map(item => {
        const pid = variationToProductMap.get(item.squareInventoryItem.catalogObjectId);
        return { ...item, productId: pid };
    });

    // Filter out SKIPPED items before processing
    // Also filter out unresolved items (productId is undefined)
    const nonSkippedBatch = resolvedBatch.filter(item => item.productId && !skippedProductIds.has(item.productId));

    const uniquePids = [...new Set(nonSkippedBatch.map(i => i.productId))] as string[];

    // B. Bulk Fetch Products
    const products = await this.prisma.product.findMany({
      where: { id: { in: uniquePids } }
    });
    const productMap = new Map(products.map(p => [p.id, p]));

    // C. Bulk Fetch API Data (Cost Basis = DESCRIPTION only)
    const catalogDataMap = new Map();
    if (input.costBasis === 'DESCRIPTION') {
      const pidsNeedingInfo = products.filter(p => !p.squareProductName).map(p => p.id);
      const itemsNeedingFetch = resolvedBatch
        .filter(i => i.productId && pidsNeedingInfo.includes(i.productId))
        .map(i => i.squareInventoryItem.catalogObjectId);

      // OPTIMIZATION: Use batchFetchSquareCatalogObjects
      if (itemsNeedingFetch.length > 0) {
        try {
            const batchResults = await this.squareInventory.batchFetchSquareCatalogObjects(itemsNeedingFetch);
            for (const [vid, data] of batchResults) {
                catalogDataMap.set(vid, data);
            }
        } catch(e) {
            this.logger.warn(`[CATALOG_FETCH_ERROR] Failed to batch fetch variations in migration:`, e);
        }
      }
    }

    // D. Pre-calculate Unit Costs (Avoid DB/CPU in transaction)
    // We calculate costs NOW. If manual input is needed, we fail fast or collect errors.
    const calculatedCosts = new Map<string, Prisma.Decimal>(); // Key: `${locationId}:${productId}`

    for (const item of nonSkippedBatch) {
      const p = productMap.get(item.productId!);
      if (!p) continue; // Will be handled in transaction error logic

      // Determine names (using pre-fetched catalog data)
      let pName = p.squareProductName || p.squareVariationName || p.name;
      let pDesc = p.squareDescription || null;
      
      const catData = catalogDataMap.get(item.squareInventoryItem.catalogObjectId);
      if (catData) {
         pName = this.normalizeSquareProductName(catData.productName, catData.itemVariationData?.name, pName);
         pDesc = catData.productDescription || pDesc;
      }

      // Determine Cost
      // Note: determineUnitCost might still do DB calls for AVERAGE_COST. 
      // If costBasis is AVERAGE_COST, we should pre-fetch SupplierProducts too. 
      // For brevity, assuming other bases or low volume of avg cost.
      try {
        const cost = await this.determineUnitCost(
          item.productId!, item.locationId, input.costBasis,
          item.squareInventoryItem.catalogObjectId,
          pName, approvedCostsMap.get(item.productId!), null, pDesc
        );
        if (cost) calculatedCosts.set(`${item.locationId}:${item.productId}`, cost);
      } catch (e) {}
    }

    // 5. TRANSACTION (Write Only)
    try {
      await this.prisma.$transaction(async (tx) => {
        // OPTIMIZATION: Batch Insert Opening Balances
        const itemsToInsert: OpeningBalanceItem[] = [];

        for (const item of nonSkippedBatch) {
          const product = productMap.get(item.productId!);
          if (!product) {
            result.errors.push({
               productId: item.productId!, locationId: item.locationId, errorType: 'DATABASE_ERROR',
               message: `Product ${item.productId} does not exist`, canProceed: false
            });
            continue;
          }

          const unitCost = calculatedCosts.get(`${item.locationId}:${item.productId}`);
          if (!unitCost) {
             result.errors.push({
               productId: item.productId, productName: product.name, locationId: item.locationId,
               errorType: 'MISSING_COST', message: 'Missing cost', canProceed: false
             });
             continue;
          }

          // Update Product Metadata if needed (from pre-fetched data)
          if (catalogDataMap.has(item.squareInventoryItem.catalogObjectId)) {
             const catData = catalogDataMap.get(item.squareInventoryItem.catalogObjectId);
             const normName = this.normalizeSquareProductName(catData.productName, catData.itemVariationData?.name, product.name);
             await tx.product.update({
               where: { id: item.productId },
               data: {
                 squareProductName: normName,
                 squareDescription: catData.productDescription || product.squareDescription,
                 squareVariationName: catData.itemVariationData?.name || product.squareVariationName,
                 squareDataSyncedAt: new Date()
               }
             });
          }

          // Normalize negative quantities to 0 and track warnings
          const originalQuantity = item.squareInventoryItem.quantity;
          const normalizedQuantity = Math.max(0, originalQuantity);
          
          if (originalQuantity < 0) {
            result.warnings.push({
              productId: item.productId,
              productName: product.name,
              locationId: item.locationId,
              message: `Quantity was negative (${originalQuantity}), normalized to 0`,
            });
          }

          // Prepare for Batch Create
          itemsToInsert.push({
             productId: item.productId!,
             locationId: item.locationId,
             quantity: normalizedQuantity,
             unitCost,
             receivedAt: input.cutoverDate,
             source: 'OPENING_BALANCE',
             costSource: input.costBasis
          });
        }
        
        // Execute Batch Insert
        if (itemsToInsert.length > 0) {
             // We need to handle potential duplicates (unique constraint on productId, locationId, source)
             // `createMany` with `skipDuplicates` works if database supports it (Postgres does)
             await tx.inventory.createMany({
                 data: itemsToInsert.map(i => ({
                     productId: i.productId,
                     locationId: i.locationId,
                     quantity: i.quantity,
                     unitCost: i.unitCost,
                     receivedAt: i.receivedAt,
                     source: i.source,
                     costSource: i.costSource
                 })),
                 skipDuplicates: true
             });
             
             result.openingBalancesCreated += itemsToInsert.length;
             result.productsProcessed += itemsToInsert.length;
        }

      }, { timeout: 30000 }); // Increase timeout for batch write

      // 6. Update Cutover Record
      const isLastBatch = currentBatch + 1 >= result.totalBatches!;
      const newProcessed = (cutoverRecord.processedItems || 0) + batchItems.length;

      await this.prisma.cutover.update({
        where: { id: cutoverRecord.id },
        data: {
          status: isLastBatch ? 'COMPLETED' : 'IN_PROGRESS',
          currentBatch: currentBatch + 1,
          processedItems: newProcessed,
          completedAt: isLastBatch ? new Date() : null,
          result: result as any,
          batchState: {
            locationIds: input.locationIds,
          } as any
        }
      });

      result.processedItems = newProcessed;
      result.currentBatch = currentBatch + 1;
      result.isComplete = isLastBatch;
      result.canContinue = !isLastBatch;

      if (isLastBatch) {
        await this.enableCutoverLock(input.cutoverDate, input.locationIds, this.prisma);
      }

    } catch (error) {
       await this.prisma.cutover.update({
         where: { id: cutoverRecord.id },
         data: { status: 'FAILED', result: result as any }
       });
       throw error;
    }

    return result;
  }

  
  async determineUnitCost(
    productId: string,
    locationId: string,
    costBasis: string,
    squareVariationId?: string | null,
    productName?: string | null,
    approvedCost?: Prisma.Decimal | null,
    manualCost?: Prisma.Decimal | null,
    productDescription?: string | null,
  ): Promise<Prisma.Decimal | null> {
    if (costBasis === 'MANUAL_INPUT') return (manualCost && manualCost.gte(0)) ? manualCost : null;
    if (costBasis === 'DESCRIPTION') {
      if (approvedCost && approvedCost.gte(0)) return approvedCost;
      if (productName) {
        const res = this.costExtraction.extractCostFromDescription(productName, productDescription);
        if (res.selectedCost != null) return new Prisma.Decimal(res.selectedCost);
      }
      return null;
    }
    if (costBasis === 'SQUARE_COST' && squareVariationId) {
      const cost = await this.squareInventory.fetchSquareCost(squareVariationId);
      return cost !== null ? new Prisma.Decimal(cost) : null;
    }
    if (costBasis === 'AVERAGE_COST') {
      const sp = await this.prisma.supplierProduct.findMany({ where: { productId }, select: { cost: true } });
      if (sp.length > 0) {
        const total = sp.reduce((acc, curr) => acc.add(curr.cost), new Prisma.Decimal(0));
        return total.div(sp.length);
      }
    }
    return null;
  }

  async createOpeningBalanceBatch(item: OpeningBalanceItem, tx: any) {
    // Validation checks... (kept from original)
    if (item.quantity < 0) throw new MigrationErrorClass('INVALID_QUANTITY', 'Quantity cannot be negative', false);
    if (item.unitCost.lt(0)) throw new MigrationErrorClass('MISSING_COST', 'Non-negative cost required', false);

    // Fast-path read (still useful), but DB uniqueness should be enforced in schema:
    // @@unique([productId, locationId, source])
    const existing = await tx.inventory.findFirst({
      where: { productId: item.productId, locationId: item.locationId, source: 'OPENING_BALANCE' }
    });
    if (existing) return existing; // Skip if already exists to allow re-run

    try {
      return await tx.inventory.create({
        data: {
          productId: item.productId, locationId: item.locationId, quantity: item.quantity,
          unitCost: item.unitCost, receivedAt: item.receivedAt, source: item.source, costSource: item.costSource
        }
      });
    } catch (e: any) {
      // Prisma unique constraint violation
      if (e?.code === 'P2002') {
        const again = await tx.inventory.findFirst({
          where: { productId: item.productId, locationId: item.locationId, source: 'OPENING_BALANCE' }
        });
        if (again) return again;
      }
      throw e;
    }
  }

  async continueBatchMigration(cutoverId: string, approvedCosts: any[]) {
      // Implementation calling executeInventoryMigration
      const cutoverRecord = await this.prisma.cutover.findUnique({ where: { id: cutoverId } });
      if (!cutoverRecord) throw new CutoverValidationError('Cutover not found', []);
      if (cutoverRecord.status !== 'IN_PROGRESS') throw new CutoverValidationError('Invalid cutover state', []);
      
      const batchState = (cutoverRecord as any).batchState as any;
      const locationIds = batchState?.locationIds || [];
      
      if (locationIds.length === 0) {
        throw new CutoverValidationError(
          'Cannot continue batch without locationIds. Please restart migration.',
          ['LocationIds not found in batchState']
        );
      }
      
      const input: CutoverInput = {
          cutoverDate: cutoverRecord.cutoverDate,
          locationIds: locationIds,
          costBasis: cutoverRecord.costBasis as any,
          ownerApproved: cutoverRecord.ownerApproved,
          ownerApprovedAt: cutoverRecord.ownerApprovedAt,
          ownerApprovedBy: cutoverRecord.ownerApprovedBy,
          approvedCosts: null
      };
      return this.executeInventoryMigration(input, approvedCosts, (cutoverRecord as any).batchSize, cutoverId);
  }

  async enableCutoverLock(cutoverDate: Date, locationIds: string[], tx: any): Promise<CutoverLock> {
      await tx.cutoverLock.createMany({
          data: locationIds.map(id => ({
              locationId: id, cutoverDate, isLocked: true, lockedAt: new Date()
          })),
          skipDuplicates: true,
      });
      return { isLocked: true, lockedAt: new Date(), lockedBy: null, cutoverDate, preventsBackdatedEdits: true, preventsBackdatedSales: true, preventsSilentCostChanges: true };
  }

  async validateNoBackdatedOperation(operationDate: Date, locationId: string) {
      const lock = await this.prisma.cutoverLock.findFirst({ where: { locationId, isLocked: true }, orderBy: { cutoverDate: 'desc' } });
      if (lock && operationDate < lock.cutoverDate) return { allowed: false, reason: 'Backdated operation' };
      return { allowed: true };
  }

  async getCutoverForLocation(locationId: string) {
      const lock = await this.prisma.cutoverLock.findFirst({ where: { locationId, isLocked: true }, orderBy: { cutoverDate: 'desc' } });
      return lock ? { cutoverDate: lock.cutoverDate } : null;
  }

  async getCutoverStatus(locationId?: string) {
      const where = { isLocked: true, ...(locationId ? { locationId } : {}) };
      const locks = await this.prisma.cutoverLock.findMany({ where, include: { location: true }, orderBy: { cutoverDate: 'desc' } });
      return {
          isLocked: locks.length > 0,
          cutoverDate: locks[0]?.cutoverDate || null,
          lockedAt: locks[0]?.lockedAt || null,
          locations: locks.map(l => ({ locationId: l.locationId, locationName: l.location?.name || 'Unknown', isLocked: true, cutoverDate: l.cutoverDate }))
      };
  }
  
  async discardItem(
    cutoverId: string,
    productId: string,
    sellingPrice?: { priceCents: number; currency: string } | null,
    sellingPriceRange?: { minCents: number; maxCents: number; currency: string } | null,
  ): Promise<{ success: boolean }> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const existingApproval = await tx.costApproval.findUnique({
          where: {
            cutoverId_productId: {
              cutoverId,
              productId,
            },
          },
        });
        const wasAlreadyProcessed = existingApproval && 
          (existingApproval.migrationStatus === 'APPROVED' || existingApproval.migrationStatus === 'SKIPPED');
        const wasPending = !existingApproval || existingApproval.migrationStatus === 'PENDING';
        
        await tx.costApproval.upsert({
          where: {
            cutoverId_productId: {
              cutoverId,
              productId,
            },
          },
          create: {
            cutoverId,
            productId,
            approvedCost: new Prisma.Decimal(0),
            source: 'SKIPPED',
            migrationStatus: 'SKIPPED',
            sellingPriceCents: sellingPrice?.priceCents || null,
            sellingPriceCurrency: sellingPrice?.currency || null,
            sellingPriceRangeMinCents: sellingPriceRange?.minCents || null,
            sellingPriceRangeMaxCents: sellingPriceRange?.maxCents || null,
          },
          update: {
            migrationStatus: 'SKIPPED',
            source: 'SKIPPED',
            sellingPriceCents: sellingPrice?.priceCents || null,
            sellingPriceCurrency: sellingPrice?.currency || null,
            sellingPriceRangeMinCents: sellingPriceRange?.minCents || null,
            sellingPriceRangeMaxCents: sellingPriceRange?.maxCents || null,
          },
        });
        
        if (wasPending && !wasAlreadyProcessed) {
          const session = await tx.extractionSession.findFirst({
            where: {
              OR: [
                { id: cutoverId },
                { cutoverId: cutoverId },
              ],
            },
          });
          
          if (session) {
            await tx.extractionSession.update({
              where: { id: session.id },
              data: {
                processedItems: {
                  increment: 1,
                },
              },
            });
          }
        }
      });

      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to discard item ${productId}: ${error}`);
      throw error;
    }
  }

  async restoreItem(
    cutoverId: string,
    productId: string,
  ): Promise<{ success: boolean }> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.costApproval.findUnique({
          where: {
            cutoverId_productId: {
              cutoverId,
              productId,
            },
          },
        });

        if (!existing) {
          return { success: true };
        }
        
        const wasProcessed = existing.migrationStatus === 'APPROVED' || existing.migrationStatus === 'SKIPPED';

        await tx.costApproval.update({
          where: {
            cutoverId_productId: {
              cutoverId,
              productId,
            },
          },
          data: {
            migrationStatus: 'PENDING',
          },
        });
        
        if (wasProcessed) {
          const session = await tx.extractionSession.findFirst({
            where: {
              OR: [
                { id: cutoverId },
                { cutoverId: cutoverId },
              ],
            },
          });
          
          if (session && session.processedItems > 0) {
            await tx.extractionSession.update({
              where: { id: session.id },
              data: {
                processedItems: {
                  decrement: 1,
                },
              },
            });
          }
        }
      });

      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to restore item ${productId}: ${error}`);
      throw error;
    }
  }

  async approveItem(
    cutoverId: string,
    productId: string,
    cost: number,
    source: string = 'DESCRIPTION',
    notes?: string | null,
    extractedEntries?: Array<{
      supplier: string;
      amount: number;
      supplierId?: string | null;
      editedSupplierName?: string | null;
      editedCost?: number | null;
      editedEffectiveDate?: string | null;
      isSelected?: boolean;
    }>,
    selectedSupplierId?: string | null,
    selectedSupplierName?: string | null,
    sellingPrice?: { priceCents: number; currency: string } | null,
    sellingPriceRange?: { minCents: number; maxCents: number; currency: string } | null,
  ): Promise<{ success: boolean }> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const existingApproval = await tx.costApproval.findUnique({
          where: {
            cutoverId_productId: {
              cutoverId,
              productId,
            },
          },
        });
        const wasAlreadyProcessed = existingApproval && 
          (existingApproval.migrationStatus === 'APPROVED' || existingApproval.migrationStatus === 'SKIPPED');
        const wasPending = !existingApproval || existingApproval.migrationStatus === 'PENDING';
        
        await tx.costApproval.upsert({
          where: {
            cutoverId_productId: {
              cutoverId,
              productId,
            },
          },
          create: {
            cutoverId,
            productId,
            approvedCost: new Prisma.Decimal(cost),
            source,
            migrationStatus: 'APPROVED',
            notes: notes || null,
            sellingPriceCents: sellingPrice?.priceCents || null,
            sellingPriceCurrency: sellingPrice?.currency || null,
            sellingPriceRangeMinCents: sellingPriceRange?.minCents || null,
            sellingPriceRangeMaxCents: sellingPriceRange?.maxCents || null,
          },
          update: {
            approvedCost: new Prisma.Decimal(cost),
            source,
            migrationStatus: 'APPROVED',
            notes: notes || null,
            sellingPriceCents: sellingPrice?.priceCents || null,
            sellingPriceCurrency: sellingPrice?.currency || null,
            sellingPriceRangeMinCents: sellingPriceRange?.minCents || null,
            sellingPriceRangeMaxCents: sellingPriceRange?.maxCents || null,
          },
        });
        
        if (wasPending && !wasAlreadyProcessed) {
          const session = await tx.extractionSession.findFirst({
            where: {
              OR: [
                { id: cutoverId },
                { cutoverId: cutoverId },
              ],
            },
          });
          
          if (session) {
            await tx.extractionSession.update({
              where: { id: session.id },
              data: {
                processedItems: {
                  increment: 1,
                },
              },
            });
          }
        }

        if (extractedEntries && extractedEntries.length > 0) {
          const effectiveDate = new Date(); 
          
          const supplierGroups = new Map<string, Array<typeof extractedEntries[0]>>();
          
          for (const entry of extractedEntries) {
            const supplierName = entry.editedSupplierName || entry.supplier;
            if (!supplierName || supplierName.trim().length === 0) {
              continue; 
            }
            
            if (!supplierGroups.has(supplierName)) {
              supplierGroups.set(supplierName, []);
            }
            supplierGroups.get(supplierName)!.push(entry);
          }

          for (const [supplierName, entries] of supplierGroups) {
            const supplier = await this.supplierService.findOrCreateSupplier(supplierName);
            
            let supplierProductCost = new Prisma.Decimal(0);
            let isPreferred = false;
            
            const selectedEntry = entries.find(e => e.isSelected) || entries[entries.length - 1];
            if (selectedEntry) {
              supplierProductCost = new Prisma.Decimal(
                selectedEntry.editedCost !== null && selectedEntry.editedCost !== undefined
                  ? selectedEntry.editedCost
                  : selectedEntry.amount
              );
              isPreferred = supplier.id === selectedSupplierId || supplierName === selectedSupplierName;
            }

            await tx.supplierProduct.upsert({
              where: {
                supplierId_productId: {
                  supplierId: supplier.id,
                  productId: productId,
                },
              },
              create: {
                supplierId: supplier.id,
                productId: productId,
                cost: supplierProductCost,
                isPreferred: isPreferred,
                notes: `Migrated from cutover ${cutoverId}`,
              },
              update: {
                cost: supplierProductCost,
                isPreferred: isPreferred,
                notes: `Updated from cutover ${cutoverId}`,
              },
            });

            await tx.supplierCostHistory.updateMany({
              where: {
                productId: productId,
                supplierId: supplier.id,
                isCurrent: true,
              },
              data: {
                isCurrent: false,
              },
            });

            const sortedEntries = [...entries].sort((a, b) => {
              if (a.isSelected && !b.isSelected) return 1;
              if (!a.isSelected && b.isSelected) return -1;
              if (a.editedEffectiveDate && b.editedEffectiveDate) {
                return new Date(a.editedEffectiveDate).getTime() - new Date(b.editedEffectiveDate).getTime();
              }
              return 0;
            });

            const hasSelectedEntry = sortedEntries.some(e => e.isSelected);

            for (let i = 0; i < sortedEntries.length; i++) {
              const entry = sortedEntries[i];
              const entryCost = new Prisma.Decimal(
                entry.editedCost !== null && entry.editedCost !== undefined
                  ? entry.editedCost
                  : entry.amount
              );
              
              const entryEffectiveDate = entry.editedEffectiveDate
                ? new Date(entry.editedEffectiveDate)
                : effectiveDate;

              const isCurrent = (hasSelectedEntry && entry.isSelected) || (!hasSelectedEntry && i === sortedEntries.length - 1);

              await tx.supplierCostHistory.create({
                data: {
                  productId: productId,
                  supplierId: supplier.id,
                  unitCost: entryCost,
                  effectiveAt: entryEffectiveDate,
                  source: 'MIGRATION',
                  isCurrent: isCurrent,
                },
              });
            }
          }
        } else if (selectedSupplierName && selectedSupplierName.trim().length > 0) {
          const supplier = await this.supplierService.findOrCreateSupplier(selectedSupplierName);
          
          await tx.supplierCostHistory.updateMany({
            where: {
              productId: productId,
              supplierId: supplier.id,
              isCurrent: true,
            },
            data: {
              isCurrent: false,
            },
          });

          await tx.supplierProduct.upsert({
            where: {
              supplierId_productId: {
                supplierId: supplier.id,
                productId: productId,
              },
            },
            create: {
              supplierId: supplier.id,
              productId: productId,
              cost: new Prisma.Decimal(cost),
              isPreferred: true,
              notes: `Migrated from cutover ${cutoverId}`,
            },
            update: {
              cost: new Prisma.Decimal(cost),
              isPreferred: true,
              notes: `Updated from cutover ${cutoverId}`,
            },
          });

          await tx.supplierCostHistory.create({
            data: {
              productId: productId,
              supplierId: supplier.id,
              unitCost: new Prisma.Decimal(cost),
              effectiveAt: new Date(),
              source: 'MIGRATION',
              isCurrent: true,
            },
          });
        }
      });

      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to approve item ${productId}: ${error}`);
      throw error;
    }
  }

  async reusePreviousApprovals(
    cutoverId: string,
    productIds?: string[],
  ): Promise<{ success: boolean; approvedCount: number; products: string[] }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const whereClause: any = {
          cutoverId: { not: cutoverId }, 
          migrationStatus: 'APPROVED', 
        };

        if (productIds && productIds.length > 0) {
          whereClause.productId = { in: productIds };
        }

        const previousApprovals = await tx.costApproval.findMany({
          where: whereClause,
          orderBy: { approvedAt: 'desc' },
          select: {
            id: true,
            productId: true,
            cutoverId: true,
            migrationStatus: true,
            approvedCost: true,
            source: true,
            notes: true,
            approvedAt: true,
            approvedBy: true,
            sellingPriceCents: true,
            sellingPriceCurrency: true,
            sellingPriceRangeMinCents: true,
            sellingPriceRangeMaxCents: true,
          },
        });

        if (previousApprovals.length === 0) {
          return { success: true, approvedCount: 0, products: [] };
        }

        const existingApprovals = await tx.costApproval.findMany({
          where: {
            cutoverId,
            productId: { in: previousApprovals.map((a) => a.productId) },
          },
          select: { productId: true },
        });

        const existingProductIds = new Set(existingApprovals.map((a) => a.productId));

        const approvalsByProduct = new Map<string, typeof previousApprovals[0]>();
        for (const approval of previousApprovals) {
          if (!approvalsByProduct.has(approval.productId)) {
            approvalsByProduct.set(approval.productId, approval);
          }
        }

        const approvalsToCreate: typeof previousApprovals = [];
        for (const [productId, approval] of approvalsByProduct.entries()) {
          if (!existingProductIds.has(productId)) {
            approvalsToCreate.push(approval);
          }
        }

        if (approvalsToCreate.length === 0) {
          return { success: true, approvedCount: 0, products: [] };
        }

        const createdProducts: string[] = [];
        for (const approval of approvalsToCreate) {
          await tx.costApproval.create({
            data: {
              cutoverId,
              productId: approval.productId,
              approvedCost: approval.approvedCost,
              source: approval.source,
              migrationStatus: 'APPROVED',
              notes: approval.notes,
              approvedAt: new Date(),
              approvedBy: approval.approvedBy,
            },
          });
          createdProducts.push(approval.productId);
        }

        const session = await tx.extractionSession.findFirst({
          where: {
            OR: [{ id: cutoverId }, { cutoverId: cutoverId }],
          },
        });

        if (session) {
          await tx.extractionSession.update({
            where: { id: session.id },
            data: {
              processedItems: {
                increment: approvalsToCreate.length,
              },
            },
          });
        }

        return {
          success: true,
          approvedCount: approvalsToCreate.length,
          products: createdProducts,
        };
      });
    } catch (error) {
      this.logger.error(`Failed to reuse previous approvals: ${error}`);
      throw error;
    }
  }

  // Helper methods like inferSupplierNameFromInitials, getExtractionSession, approveBatch, generateUUID
  // Adding minimal placeholders to ensure file compilation if they were missing from my read, 
  // but based on context they were likely imported or part of the file. 
  // I will assume they are methods I need to keep.
  
  private inferSupplierNameFromInitials(initials: string, learned: Record<string, string[]>): string | null {
    if (!initials) return null;
    const normalized = initials.toUpperCase().trim();
    
    // Check learned initials first
    for (const [supplierName, learnedInitials] of Object.entries(learned)) {
      if (Array.isArray(learnedInitials) && learnedInitials.some(i => i.toUpperCase() === normalized)) {
        return supplierName;
      }
    }
    return null;
  }

  async getExtractionSession(id: string) {
     return this.prisma.extractionSession.findUnique({ 
       where: { id },
       include: { batches: true } 
     });
  }

  async updateBatchSize(extractionSessionId: string, newBatchSize: number) {
    const session = await this.prisma.extractionSession.findUnique({
      where: { id: extractionSessionId },
    });

    if (!session) {
      throw new Error('Extraction session not found');
    }

    const remainingItems = session.totalItems - session.processedItems;
    const newTotalBatches = Math.ceil(remainingItems / newBatchSize);
    
    await this.prisma.extractionSession.update({
      where: { id: extractionSessionId },
      data: {
        batchSize: newBatchSize,
        totalBatches: session.currentBatch + newTotalBatches - 1,
      },
    });

    return { success: true, batchSize: newBatchSize };
  }

  async listExtractionSessions(locationId?: string) {
    const where: any = {};
    if (locationId) {
      where.locationIds = { has: locationId };
    }

    return this.prisma.extractionSession.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  async approveBatch(
    batchId: string,
    extractionApproved: boolean,
    manualInputApproved: boolean,
    approvedCosts: Array<{
      productId: string;
      cost: Prisma.Decimal;
      source: string;
      notes?: string | null;
      supplierId?: string | null;
      supplierName?: string | null;
      isPreferred?: boolean;
    }>,
    supplierInitialsUpdates?: Array<{ supplierName: string; initials: string[] }> | null,
    entriesToAddToHistory?: Array<{
      productId: string;
      supplierName: string;
      supplierId?: string | null;
      cost: number;
      effectiveAt?: Date;
    }> | null,
    approvedBy?: string | null,
    effectiveAt?: Date | null,
  ): Promise<{ nextBatchAvailable: boolean; lastApprovedProductId?: string | null }> {
    // 1. Validate Batch
    const session = await this.prisma.extractionSession.findUnique({
      where: { id: batchId },
    });

    if (!session) {
      throw new Error('Extraction session not found');
    }
    
    if (!session.cutoverId) {
       throw new Error('Extraction session is not linked to a cutover');
    }

    // 2. Store approvals
    await this.storeCostApprovals(
      session.cutoverId,
      approvedCosts,
      approvedBy,
      effectiveAt,
      entriesToAddToHistory
    );

    // 3. Update Supplier Initials if provided
    if (supplierInitialsUpdates && supplierInitialsUpdates.length > 0) {
      const currentLearned = (session.learnedSupplierInitials as Record<string, string[]>) || {};
      const updatedLearned = { ...currentLearned };
      
      for (const update of supplierInitialsUpdates) {
        updatedLearned[update.supplierName] = update.initials;
      }
      
      await this.prisma.extractionSession.update({
        where: { id: batchId },
        data: { learnedSupplierInitials: updatedLearned },
      });
    }

    // 4. Check if there's a next batch
    const isComplete = session.totalBatches !== null && session.currentBatch >= session.totalBatches;
    const nextBatchAvailable = !isComplete;

    return {
      nextBatchAvailable,
      lastApprovedProductId: approvedCosts.length > 0 ? approvedCosts[approvedCosts.length - 1].productId : null,
    };
  }

  async storeCostApprovals(
    cutoverId: string,
    approvedCosts: Array<{
      productId: string;
      cost: Prisma.Decimal;
      source: string;
      notes?: string | null;
      supplierId?: string | null;
      supplierName?: string | null;
      isPreferred?: boolean;
    }>,
    approvedBy?: string | null,
    effectiveAt?: Date | null,
    entriesToAddToHistory?: Array<{
      productId: string;
      supplierName: string;
      supplierId?: string | null;
      cost: number;
      effectiveAt?: Date;
    }> | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
        // Bulk upsert not directly supported in Prisma easily without raw query or loop
        // Loop is fine for batch sizes ~50-100
        for (const ac of approvedCosts) {
            await tx.costApproval.upsert({
                where: {
                    cutoverId_productId: {
                        cutoverId: cutoverId,
                        productId: ac.productId
                    }
                },
                create: {
                    cutoverId: cutoverId,
                    productId: ac.productId,
                    approvedCost: ac.cost,
                    source: ac.source,
                    notes: ac.notes,
                    migrationStatus: 'APPROVED',
                    approvedBy: approvedBy || null,
                    approvedAt: new Date(), // Now
                },
                update: {
                    approvedCost: ac.cost,
                    source: ac.source,
                    notes: ac.notes,
                    migrationStatus: 'APPROVED',
                    approvedBy: approvedBy || null,
                    approvedAt: new Date(),
                }
            });

            // Update Supplier Product if provided
            if (ac.supplierId || ac.supplierName) {
                // Determine supplier ID if only name provided
                let supplierId = ac.supplierId;
                if (!supplierId && ac.supplierName) {
                    const sup = await this.supplierService.findOrCreateSupplier(ac.supplierName);
                    supplierId = sup.id;
                }

                if (supplierId) {
                    await tx.supplierProduct.upsert({
                        where: {
                            supplierId_productId: {
                                supplierId: supplierId,
                                productId: ac.productId
                            }
                        },
                        create: {
                            supplierId: supplierId,
                            productId: ac.productId,
                            cost: ac.cost,
                            isPreferred: ac.isPreferred || false,
                            notes: ac.notes
                        },
                        update: {
                            cost: ac.cost,
                            isPreferred: ac.isPreferred || false,
                            notes: ac.notes
                        }
                    });
                }
            }
        }

        // Process extra history entries
        if (entriesToAddToHistory && entriesToAddToHistory.length > 0) {
            for (const entry of entriesToAddToHistory) {
                let supplierId = entry.supplierId;
                if (!supplierId && entry.supplierName) {
                    const sup = await this.supplierService.findOrCreateSupplier(entry.supplierName);
                    supplierId = sup.id;
                }

                if (supplierId) {
                    await tx.supplierCostHistory.create({
                        data: {
                            productId: entry.productId,
                            supplierId: supplierId,
                            unitCost: new Prisma.Decimal(entry.cost),
                            effectiveAt: entry.effectiveAt || new Date(),
                            source: 'MIGRATION_HISTORY',
                            isCurrent: false // History entries usually aren't current unless most recent
                        }
                    });
                }
            }
        }
    });
  }

  async getCostApprovals(
    cutoverId: string,
  ): Promise<{ productId: string; cost: Prisma.Decimal }[]> {
    const approvals = await this.prisma.costApproval.findMany({
      where: { 
          cutoverId: cutoverId,
          migrationStatus: 'APPROVED'
      },
      select: {
        productId: true,
        approvedCost: true,
      },
    });

    return approvals.map((a) => ({
      productId: a.productId,
      cost: a.approvedCost,
    }));
  }

  /**
   * Get summary of all approved and skipped items for a cutover/extraction session
   * Returns counts and lists of items by status across all batches
   * 
   * @param cutoverId - The current cutover/session ID
   * @param includeAllSessions - If true, includes approvals from ALL sessions (historical)
   */
  async getApprovalsSummary(
    cutoverId: string,
    includeAllSessions: boolean = false,
  ): Promise<{
    approvedCount: number;
    skippedCount: number;
    pendingCount: number;
    currentSessionApprovedCount: number;
    currentSessionSkippedCount: number;
    approvedItems: Array<{
      productId: string;
      productName: string | null;
      approvedCost: number;
      source: string;
      approvedAt: Date | null;
      sellingPriceCents: number | null;
      sellingPriceCurrency: string | null;
      cutoverId: string;
      isFromCurrentSession: boolean;
    }>;
    skippedItems: Array<{
      productId: string;
      productName: string | null;
      cutoverId: string;
      isFromCurrentSession: boolean;
    }>;
  }> {
    // Get approvals - either for this cutover only, or all historical
    const whereClause = includeAllSessions ? {} : { cutoverId };
    
    const allApprovals = await this.prisma.costApproval.findMany({
      where: whereClause,
      include: {
        product: {
          select: {
            id: true,
            name: true,
            squareProductName: true,
            squareVariationName: true,
          },
        },
      },
      orderBy: { approvedAt: 'desc' },
    });

    // If includeAllSessions, deduplicate by productId (keep most recent)
    let deduplicatedApprovals = allApprovals;
    if (includeAllSessions) {
      const seenProducts = new Map<string, typeof allApprovals[0]>();
      for (const approval of allApprovals) {
        // Keep the first one (most recent due to orderBy)
        if (!seenProducts.has(approval.productId)) {
          seenProducts.set(approval.productId, approval);
        }
      }
      deduplicatedApprovals = Array.from(seenProducts.values());
    }

    const approved = deduplicatedApprovals.filter(a => a.migrationStatus === 'APPROVED');
    const skipped = deduplicatedApprovals.filter(a => a.migrationStatus === 'SKIPPED');
    const pending = deduplicatedApprovals.filter(a => a.migrationStatus === 'PENDING');

    // Count current session items
    const currentSessionApproved = approved.filter(a => a.cutoverId === cutoverId);
    const currentSessionSkipped = skipped.filter(a => a.cutoverId === cutoverId);

    return {
      approvedCount: approved.length,
      skippedCount: skipped.length,
      pendingCount: pending.length,
      currentSessionApprovedCount: currentSessionApproved.length,
      currentSessionSkippedCount: currentSessionSkipped.length,
      approvedItems: approved.map(a => ({
        productId: a.productId,
        productName: a.product?.squareProductName || a.product?.squareVariationName || a.product?.name || null,
        approvedCost: a.approvedCost.toNumber(),
        source: a.source,
        approvedAt: a.approvedAt,
        sellingPriceCents: a.sellingPriceCents,
        sellingPriceCurrency: a.sellingPriceCurrency,
        cutoverId: a.cutoverId,
        isFromCurrentSession: a.cutoverId === cutoverId,
      })),
      skippedItems: skipped.map(a => ({
        productId: a.productId,
        productName: a.product?.squareProductName || a.product?.squareVariationName || a.product?.name || null,
        cutoverId: a.cutoverId,
        isFromCurrentSession: a.cutoverId === cutoverId,
      })),
    };
  }

  private generateUUID(): string {
    return randomUUID();
  }
  
  async previewCutover(
    input: CutoverInput,
    approvedCosts?: { productId: string; cost: Prisma.Decimal }[],
  ): Promise<{
    locations: LocationPreview[];
    totalProducts: number;
    productsWithCost: number;
    productsMissingCost: number;
    estimatedOpeningBalances: number;
    warnings: MigrationWarning[];
  }> {
    const locations: LocationPreview[] = [];
    let totalProducts = 0;
    let productsWithCost = 0;
    let productsMissingCost = 0;
    const warnings: MigrationWarning[] = [];

    const approvedCostsMap = new Map<string, Prisma.Decimal>();
    if (approvedCosts) {
      for (const approvedCost of approvedCosts) {
        approvedCostsMap.set(approvedCost.productId, approvedCost.cost);
      }
    }

    for (const locationId of input.locationIds) {
      const location = await this.prisma.location.findUnique({
        where: { id: locationId },
      });

      if (!location || !location.squareId) {
        warnings.push({
          locationId: locationId,
          message: 'Location does not have Square ID configured',
          recommendation: 'Configure Square ID for location',
        });
        continue;
      }

      let squareInventory;
      try {
        squareInventory = await this.squareInventory.fetchSquareInventory(
          location.squareId,
        );
      } catch (error) {
        warnings.push({
          locationId: locationId,
          message: `Failed to fetch Square inventory for location ${location.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        continue;
      }

      // Optimization: Batch process
      // 1. Collect IDs
      const catalogObjectIds = squareInventory.map((item) => item.catalogObjectId);

      // 2. Batch resolve products
      const variationToProductMap =
        await this.catalogMapper.batchResolveProductsFromSquareVariations(
          catalogObjectIds,
          locationId,
        );

      // 3. Batch fetch catalog objects (needed for DESCRIPTION basis or just name fallback)
      let catalogObjectsMap = new Map();
      if (input.costBasis === 'DESCRIPTION') {
         try {
            catalogObjectsMap = await this.squareInventory.batchFetchSquareCatalogObjects(catalogObjectIds);
         } catch (e) {
             warnings.push({ locationId, message: 'Failed to batch fetch catalog objects' });
         }
      }

      // 4. Fetch products
      const productIds = Array.from(variationToProductMap.values());
      const products = await this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true },
      });
      const productsMap = new Map(products.map((p) => [p.id, p]));

      // 5. Batch fetch average costs if needed
      let averageCostsMap = new Map<string, Prisma.Decimal>();
      if (input.costBasis === 'AVERAGE_COST') {
        const supplierProducts = await this.prisma.supplierProduct.findMany({
          where: { productId: { in: productIds } },
          select: { productId: true, cost: true },
        });

        // Group by product and calculate average
        const productCosts = new Map<string, Prisma.Decimal[]>();
        for (const sp of supplierProducts) {
          if (!productCosts.has(sp.productId)) {
            productCosts.set(sp.productId, []);
          }
          productCosts.get(sp.productId)!.push(sp.cost);
        }

        for (const [productId, costs] of productCosts.entries()) {
          let total = new Prisma.Decimal(0);
          for (const cost of costs) total = total.add(cost);
          averageCostsMap.set(productId, total.div(costs.length));
        }
      }

      const productsPreview: ProductPreview[] = [];

      for (const item of squareInventory) {
        try {
          const productId = variationToProductMap.get(item.catalogObjectId);
          if (!productId) {
             continue; 
          }

          const product = productsMap.get(productId);
          if (!product) {
            continue;
          }

          const approvedCost = approvedCostsMap.get(productId);

          let productNameForExtraction = product.name;
          if (input.costBasis === 'DESCRIPTION') {
            const catalogObject = catalogObjectsMap.get(item.catalogObjectId);
            productNameForExtraction =
              catalogObject?.itemVariationData?.name || product.name;
          }

          // Use optimized determination logic
          let unitCost: Prisma.Decimal | null = null;
          
          if (input.costBasis === 'MANUAL_INPUT') {
               // In preview, manual inputs are usually in approvedCosts
               if (approvedCost) unitCost = approvedCost;
          } else if (input.costBasis === 'DESCRIPTION') {
              if (approvedCost) {
                  unitCost = approvedCost;
              } else {
                  const extractionResult = this.costExtraction.extractCostFromDescription(productNameForExtraction);
                   if (
                      extractionResult.selectedCost !== null &&
                      extractionResult.selectedCost !== undefined
                    ) {
                      unitCost = new Prisma.Decimal(extractionResult.selectedCost);
                    }
              }
          } else if (input.costBasis === 'SQUARE_COST') {
               // Assuming batchFetchSquareCosts is implemented or we rely on determineUnitCost which returns null currently
               unitCost = null; 
          } else if (input.costBasis === 'AVERAGE_COST') {
              unitCost = averageCostsMap.get(productId) || null;
          }

          const hasCost = unitCost !== null;

          productsPreview.push({
            productId: productId,
            productName: product.name,
            quantity: item.quantity,
            unitCost: unitCost ? unitCost.toNumber() : null,
            costSource: hasCost ? input.costBasis : null,
            hasCost: hasCost,
          });

          totalProducts++;
          if (hasCost) {
            productsWithCost++;
          } else {
            productsMissingCost++;
          }
        } catch (error) {
          warnings.push({
            productId: undefined,
            locationId: locationId,
            message: `Error processing item: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      }

      locations.push({
        locationId: locationId,
        locationName: location.name,
        products: productsPreview,
        totalProducts: productsPreview.length,
        productsWithCost: productsPreview.filter((p) => p.hasCost).length,
        productsMissingCost: productsPreview.filter((p) => !p.hasCost).length,
      });
    }

    return {
      locations: locations,
      totalProducts: totalProducts,
      productsWithCost: productsWithCost,
      productsMissingCost: productsMissingCost,
      estimatedOpeningBalances: productsWithCost,
      warnings: warnings,
    };
  }
}
