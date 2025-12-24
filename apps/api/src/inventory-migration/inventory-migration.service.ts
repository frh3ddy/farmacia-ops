import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, PrismaClient } from '@prisma/client';
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
} from './types';
import {
  MigrationError as MigrationErrorClass,
  CutoverValidationError,
  MissingCostError,
} from './errors';
import { SquareInventoryService } from './square-inventory.service';
import { CostExtractionService } from './cost-extraction.service';
import { CatalogMapperService } from './catalog-mapper.service';
import { SupplierService } from './supplier.service';

@Injectable()
export class InventoryMigrationService {
  // In-memory store for extraction sessions (keyed by sessionId)
  private extractionSessions = new Map<
    string,
    {
      locationIds: string[];
      allItems: Array<{
        locationId: string;
        locationName: string;
        squareInventoryItem: any;
      }>;
      extractionResults: CostExtractionResult[];
      processedItemKeys: Set<string>; // Track processed items (location:variation)
      processedProductIds: Set<string>; // Track products we've extracted costs for (deduplication)
      batchSize: number;
      currentBatch: number;
      totalBatches: number;
      totalItems: number;
    }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly squareInventory: SquareInventoryService,
    private readonly costExtraction: CostExtractionService,
    private readonly catalogMapper: CatalogMapperService,
    private readonly supplierService: SupplierService,
  ) {}

  /**
   * Validate cutover input parameters before migration
   */
  async validateCutoverInput(input: CutoverInput): Promise<{
    valid: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];

    // Validate cutover date
    if (input.cutoverDate > new Date()) {
      errors.push('Cutover date cannot be in the future');
    }

    // Validate owner approval
    if (!input.ownerApproved) {
      errors.push('Cutover must be explicitly approved by owner');
    }

    // Validate locations
    if (input.locationIds.length === 0) {
      errors.push('At least one location must be specified');
    }

    for (const locationId of input.locationIds) {
      const location = await this.prisma.location.findUnique({
        where: { id: locationId },
      });
      if (!location) {
        errors.push(`Location ${locationId} does not exist`);
      }
    }

    // Validate cost basis
    const validCostBases = [
      'SQUARE_COST',
      'DESCRIPTION',
      'MANUAL_INPUT',
      'AVERAGE_COST',
    ];
    if (!validCostBases.includes(input.costBasis)) {
      errors.push(`Invalid cost basis: ${input.costBasis}`);
    }

    // Validate cost approval for DESCRIPTION basis
    // Note: For DESCRIPTION cost basis, approved costs are recommended but migration can proceed
    // without them (it will extract costs on-the-fly), though upfront extraction is more accurate
    if (input.costBasis === 'DESCRIPTION') {
      if (!input.approvedCosts || input.approvedCosts.length === 0) {
        // Allow migration to proceed, but it's better to extract and approve upfront
        // Migration will extract costs on-the-fly if needed
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors,
    };
  }

  /**
   * Extract costs from all products for migration preview and approval
   * Supports batch processing to avoid timeouts
   * OPTIMIZED: Deduplicates cost extraction by productId (not by location)
   */
  async extractCostsForMigration(
    locationIds: string[],
    costBasis: 'DESCRIPTION',
    batchSize?: number | null,
    extractionSessionId?: string | null,
  ): Promise<CostApprovalRequest> {
    // Get or create extraction session
    let sessionId = extractionSessionId || this.generateUUID();
    let session = this.extractionSessions.get(sessionId);

    // If resuming, use existing session; otherwise create new
    if (!session) {
      // Step 1: Collect all items to process
      interface ItemToProcess {
        locationId: string;
        locationName: string;
        squareInventoryItem: any;
      }

      const allItems: ItemToProcess[] = [];

      // Collect items from all locations
      for (const locationId of locationIds) {
        const location = await this.prisma.location.findUnique({
          where: { id: locationId },
        });

        if (!location || !location.squareId) {
          continue;
        }

        // Fetch Square inventory
        const squareInventory =
          await this.squareInventory.fetchSquareInventory(location.squareId);

        // Add items to process list
        for (const item of squareInventory) {
          allItems.push({
            locationId: locationId,
            locationName: location.name,
            squareInventoryItem: item,
          });
        }
      }

      // Calculate batches
      const effectiveBatchSize = batchSize != null && batchSize > 0 
        ? batchSize 
        : allItems.length;
      const totalBatches = Math.ceil(allItems.length / effectiveBatchSize);

      // Create new session
      session = {
        locationIds: locationIds,
        allItems: allItems,
        extractionResults: [],
        processedItemKeys: new Set<string>(),
        processedProductIds: new Set<string>(), // NEW: Track products we've extracted costs for
        batchSize: effectiveBatchSize,
        currentBatch: 0,
        totalBatches: totalBatches,
        totalItems: allItems.length,
      };

      this.extractionSessions.set(sessionId, session);
    }

    // Step 2: Process current batch
    const startIndex = session.currentBatch * session.batchSize;
    const endIndex = Math.min(startIndex + session.batchSize, session.allItems.length);
    const batchItems = session.allItems.slice(startIndex, endIndex);

    console.log(`[EXTRACTION_BATCH] Processing batch ${session.currentBatch + 1}/${session.totalBatches}`);
    console.log(`[EXTRACTION_BATCH] Items ${startIndex} to ${endIndex} (${batchItems.length} items)`);

    let batchProductsWithExtraction = 0;
    let batchProductsRequiringManualInput = 0;

    // Process batch items
    for (const itemData of batchItems) {
      const { locationId, locationName, squareInventoryItem: item } = itemData;
      const itemKey = `${locationId}:${item.catalogObjectId}`;

      // Skip if already processed (for tracking purposes)
      if (session.processedItemKeys.has(itemKey)) {
        continue;
      }

      try {
        // Resolve product
        const productId = await this.catalogMapper.resolveProductFromSquareVariation(
          item.catalogObjectId,
          locationId,
        );

        const product = await this.prisma.product.findUnique({
          where: { id: productId },
          select: {
            id: true,
            name: true,
            squareProductName: true,
            squareDescription: true,
            squareImageUrl: true,
            squareVariationName: true,
            squareDataSyncedAt: true,
          },
        });

        if (!product) {
          // Still mark as processed to avoid retrying
          session.processedItemKeys.add(itemKey);
          continue;
        }

        // OPTIMIZATION: Check if we've already extracted costs for this product
        // If yes, skip extraction but still mark item as processed
        if (session.processedProductIds.has(productId)) {
          console.log(`[COST_EXTRACTION] Skipping duplicate extraction for product ${productId} (already extracted)`);
          session.processedItemKeys.add(itemKey);
          continue;
        }

        // Check if product already has approved costs from any previous cutover
        const existingApproval = await this.prisma.costApproval.findFirst({
          where: { productId: productId },
          orderBy: { approvedAt: 'desc' }, // Get most recent approval
        });

        if (existingApproval) {
          console.log(`[COST_EXTRACTION] Product ${productId} already has approved cost from cutover ${existingApproval.cutoverId}`);
          
          // Use stored Square data first, fallback to Square API if missing
          let productName = product.squareProductName || product.squareVariationName || product.name;
          let productDescription = product.squareDescription || null;
          let imageUrl = product.squareImageUrl || null;

          // Only fetch from Square API if stored data is missing
          if (!product.squareProductName || !product.squareDescription) {
            try {
              const catalogObject =
                await this.squareInventory.fetchSquareCatalogObject(
                  item.catalogObjectId,
                );

              if (catalogObject) {
                // Use fetched data if stored data is missing
                const squareProductName = catalogObject.productName || null;
                const squareVariationName = catalogObject.itemVariationData?.name || null;

                // Filter out "Sin variación"
                const filteredSquareName =
                  squareProductName &&
                  !squareProductName.toLowerCase().includes('sin variación') &&
                  !squareProductName.toLowerCase().includes('no variation') &&
                  squareProductName.trim().length > 0
                    ? squareProductName
                    : null;

                const filteredVariationName =
                  squareVariationName &&
                  !squareVariationName.toLowerCase().includes('sin variación') &&
                  !squareVariationName.toLowerCase().includes('no variation') &&
                  squareVariationName.trim().length > 0
                    ? squareVariationName
                    : null;

                productName =
                  filteredSquareName ||
                  filteredVariationName ||
                  product.squareProductName ||
                  product.squareVariationName ||
                  product.name;
                productDescription =
                  catalogObject.productDescription || product.squareDescription;
                imageUrl = catalogObject.imageUrl || product.squareImageUrl;

                // Update product with fetched data for next time
                await this.prisma.product.update({
                  where: { id: productId },
                  data: {
                    squareProductName: filteredSquareName || product.squareProductName,
                    squareDescription:
                      catalogObject.productDescription || product.squareDescription,
                    squareImageUrl: catalogObject.imageUrl || product.squareImageUrl,
                    squareVariationName:
                      filteredVariationName || product.squareVariationName,
                    squareDataSyncedAt: new Date(),
                  },
                });
              }
            } catch (error) {
              console.warn(
                `[COST_EXTRACTION] Failed to fetch catalog object for ${item.catalogObjectId}:`,
                error,
              );
              // Continue with stored data or fallback
            }
          }

          // Create result with approval metadata (skip actual extraction)
          const fullResult: CostExtractionResult = {
            productId: productId,
            productName: productName,
            originalDescription: productName,
            extractedEntries: [], // No extraction needed
            selectedCost: existingApproval.approvedCost.toNumber(),
            extractionErrors: [],
            requiresManualReview: false,
            isAlreadyApproved: true,
            existingApprovedCost: existingApproval.approvedCost,
            existingApprovalDate: existingApproval.approvedAt,
            existingCutoverId: existingApproval.cutoverId,
            imageUrl: imageUrl,
          };

          session.extractionResults.push(fullResult);
          session.processedProductIds.add(productId);
          session.processedItemKeys.add(itemKey);
          continue; // Skip extraction process
        }

        // Use stored Square data first, fallback to Square API if missing
        let productName =
          product.squareProductName ||
          product.squareVariationName ||
          product.name;
        let productDescription = product.squareDescription || null;
        let imageUrl = product.squareImageUrl || null;
        let catalogObject = null;

        // Only fetch from Square API if stored data is missing
        if (!product.squareProductName || !product.squareDescription) {
          try {
            catalogObject =
              await this.squareInventory.fetchSquareCatalogObject(
                item.catalogObjectId,
              );

            if (catalogObject) {
              // Use fetched data if stored data is missing
              const squareProductName = catalogObject.productName || null;
              const squareVariationName =
                catalogObject.itemVariationData?.name || null;

              // Filter out "Sin variación"
              const filteredSquareName =
                squareProductName &&
                !squareProductName.toLowerCase().includes('sin variación') &&
                !squareProductName.toLowerCase().includes('no variation') &&
                squareProductName.trim().length > 0
                  ? squareProductName
                  : null;

              const filteredVariationName =
                squareVariationName &&
                !squareVariationName.toLowerCase().includes('sin variación') &&
                !squareVariationName.toLowerCase().includes('no variation') &&
                squareVariationName.trim().length > 0
                  ? squareVariationName
                  : null;

              productName =
                filteredSquareName ||
                filteredVariationName ||
                product.squareProductName ||
                product.squareVariationName ||
                product.name;
              productDescription =
                catalogObject.productDescription || product.squareDescription;
              imageUrl = catalogObject.imageUrl || product.squareImageUrl;

              // Update product with fetched data for next time
              await this.prisma.product.update({
                where: { id: productId },
                data: {
                  squareProductName: filteredSquareName || product.squareProductName,
                  squareDescription:
                    catalogObject.productDescription || product.squareDescription,
                  squareImageUrl: catalogObject.imageUrl || product.squareImageUrl,
                  squareVariationName:
                    filteredVariationName || product.squareVariationName,
                  squareDataSyncedAt: new Date(),
                },
              });
            }
          } catch (error) {
            console.warn(
              `[COST_EXTRACTION] Failed to fetch catalog object for ${item.catalogObjectId}:`,
              error,
            );
            // Continue with stored data or fallback
          }
        }

        // Extract costs from product name and description
        // This is done ONCE per product, not per location
        const extractionResult = this.costExtraction.extractCostFromDescription(
          productName,
          productDescription,
        );

        // Enrich extracted entries with supplier lookups and suggestions
        const totalEntries = extractionResult.extractedEntries.length;
        const enrichedEntries = await Promise.all(
          extractionResult.extractedEntries.map(async (entry, idx) => {
            // Lookup existing suppliers by supplier name
            const suggestions = await this.supplierService.suggestSuppliers(
              entry.supplier,
              5,
            );

            // Try to find exact match
            let supplierId: string | null = null;
            const exactMatch = suggestions.find(
              (s) =>
                s.name.toLowerCase().trim() === entry.supplier.toLowerCase().trim(),
            );
            if (exactMatch) {
              supplierId = exactMatch.id;
            }

            // Calculate default date: use extracted month if available, otherwise one week ago
            let defaultDateString: string;
            if (entry.month) {
              // Convert month name to date (use first day of that month)
              const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
              const monthIndex = monthNames.indexOf(entry.month);
              if (monthIndex !== -1) {
                const now = new Date();
                const currentYear = now.getFullYear();
                const currentMonth = now.getMonth();
                // Use the extracted month, first day of month
                // If the extracted month is later in the year than current month, use previous year
                const year = monthIndex > currentMonth ? currentYear - 1 : currentYear;
                const extractedDate = new Date(year, monthIndex, 1);
                defaultDateString = extractedDate.toISOString().split('T')[0];
              } else {
                // Fallback: one week ago
                const defaultDate = new Date();
                defaultDate.setDate(defaultDate.getDate() - 7);
                defaultDateString = defaultDate.toISOString().split('T')[0];
              }
            } else {
              // Default date: one week prior to current date
              const defaultDate = new Date();
              defaultDate.setDate(defaultDate.getDate() - 7);
              defaultDateString = defaultDate.toISOString().split('T')[0];
            }

            // Set last entry as selected by default
            const isLastEntry = idx === totalEntries - 1;
            
            return {
              ...entry,
              supplierId: supplierId,
              isEditable: true,
              suggestedSuppliers: suggestions,
              addToHistory: true, // Default: add all entries to history
              editedSupplierName: null, // Initialize editable name
              editedCost: null, // Initialize editable cost
              editedEffectiveDate: defaultDateString, // Use extracted month date or default to one week ago
              isSelected: isLastEntry, // Last entry is selected by default
            };
          }),
        );

        const fullResult: CostExtractionResult = {
          ...extractionResult,
          productId: productId,
          productName: productName, // Use calculated productName (from stored data, Square API, or DB)
          originalDescription: productName,
          extractedEntries: enrichedEntries,
          imageUrl: imageUrl, // Use stored or fetched image URL
        };

        // Add extraction result (once per product)
        session.extractionResults.push(fullResult);
        
        // Mark product as processed (so we don't extract costs again for this product)
        session.processedProductIds.add(productId);
        
        // Mark item as processed (for tracking)
        session.processedItemKeys.add(itemKey);

        if (extractionResult.extractedEntries.length > 0) {
          batchProductsWithExtraction++;
        } else {
          batchProductsRequiringManualInput++;
        }
      } catch (error) {
        // Log error, continue processing
        console.error(
          `[COST_EXTRACTION] Error processing item ${item.catalogObjectId}:`,
          error,
        );
        // Still mark as processed to avoid infinite retries
        session.processedItemKeys.add(itemKey);
        continue;
      }
    }

    // Update session for next batch
    session.currentBatch++;
    const isComplete = session.currentBatch >= session.totalBatches;

    // Calculate totals from all processed results
    let totalProductsWithExtraction = 0;
    let totalProductsRequiringManualInput = 0;
    for (const result of session.extractionResults) {
      if (result.extractedEntries.length > 0) {
        totalProductsWithExtraction++;
      } else {
        totalProductsRequiringManualInput++;
      }
    }

    return {
      cutoverId: sessionId, // Use sessionId as cutoverId for tracking
      locationIds: session.locationIds,
      costBasis: costBasis,
      extractionResults: session.extractionResults,
      totalProducts: session.extractionResults.length, // This is now unique products, not total items
      productsWithExtraction: totalProductsWithExtraction,
      productsRequiringManualInput: totalProductsRequiringManualInput,
      batchSize: session.batchSize,
      currentBatch: session.currentBatch,
      totalBatches: session.totalBatches,
      processedItems: session.processedItemKeys.size, // Total items processed (for progress tracking)
      totalItems: session.totalItems, // Total items across all locations
      isComplete: isComplete,
      canContinue: !isComplete,
      extractionSessionId: sessionId,
    };
  }

  /**
   * Determine unit cost for a product based on cost basis strategy
   */
  async determineUnitCost(
    productId: string,
    locationId: string,
    costBasis: 'SQUARE_COST' | 'DESCRIPTION' | 'MANUAL_INPUT' | 'AVERAGE_COST',
    squareVariationId?: string | null,
    productName?: string | null,
    approvedCost?: Prisma.Decimal | null,
    manualCost?: Prisma.Decimal | null,
    productDescription?: string | null,
  ): Promise<Prisma.Decimal | null> {
    if (costBasis === 'MANUAL_INPUT') {
      if (!manualCost || manualCost.lessThan(0)) {
        return null;
      }
      return manualCost;
    }

    if (costBasis === 'DESCRIPTION') {
      // Use owner-approved cost (from approval step)
      if (approvedCost && approvedCost.greaterThanOrEqualTo(0)) {
        return approvedCost;
      }

      // Fallback: extract and use last entry (should not happen if approval step worked)
      if (productName) {
        const extractionResult =
          this.costExtraction.extractCostFromDescription(productName, productDescription);
        if (
          extractionResult.selectedCost !== null &&
          extractionResult.selectedCost !== undefined
        ) {
          return new Prisma.Decimal(extractionResult.selectedCost);
        }
      }

      return null;
    }

    if (costBasis === 'SQUARE_COST') {
      // Try to fetch cost from Square (if available)
      if (squareVariationId) {
        const squareCost =
          await this.squareInventory.fetchSquareCost(squareVariationId);
        if (squareCost !== null) {
          return new Prisma.Decimal(squareCost);
        }
      }
      return null;
    }

    if (costBasis === 'AVERAGE_COST') {
      // Calculate average from SupplierProduct costs
      const supplierProducts = await this.prisma.supplierProduct.findMany({
        where: { productId: productId },
        select: { cost: true },
      });

      if (supplierProducts.length > 0) {
        let totalCost = new Prisma.Decimal(0);
        for (const sp of supplierProducts) {
          totalCost = totalCost.add(sp.cost);
        }
        const averageCost = totalCost.div(supplierProducts.length);
        return averageCost;
      }
      return null;
    }

    return null;
  }

  /**
   * Create opening balance inventory batch for a product × location
   */
  async createOpeningBalanceBatch(
    item: OpeningBalanceItem,
    tx: Omit<
      PrismaClient,
      '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
    >,
  ) {
    // Validate product exists
    const product = await tx.product.findUnique({
      where: { id: item.productId },
    });
    if (!product) {
      throw new MigrationErrorClass(
        'DATABASE_ERROR',
        `Product ${item.productId} does not exist`,
        false,
        item.productId,
        item.locationId,
      );
    }

    // Validate location exists
    const location = await tx.location.findUnique({
      where: { id: item.locationId },
    });
    if (!location) {
      throw new MigrationErrorClass(
        'DATABASE_ERROR',
        `Location ${item.locationId} does not exist`,
        false,
        item.productId,
        item.locationId,
      );
    }

    // Validate quantity
    if (item.quantity <= 0) {
      throw new MigrationErrorClass(
        'INVALID_QUANTITY',
        `Quantity must be positive, got ${item.quantity}`,
        false,
        item.productId,
        item.locationId,
      );
    }

    // Validate cost
    if (item.unitCost.lessThan(0)) {
      throw new MigrationErrorClass(
        'MISSING_COST',
        `Unit cost must be non-negative, got ${item.unitCost.toString()}`,
        false,
        item.productId,
        item.locationId,
      );
    }

    // Check if opening balance already exists
    const existing = await tx.inventory.findFirst({
      where: {
        productId: item.productId,
        locationId: item.locationId,
        source: 'OPENING_BALANCE',
        receivedAt: item.receivedAt,
      },
    });

    if (existing) {
      throw new MigrationErrorClass(
        'DATABASE_ERROR',
        `Opening balance already exists for product ${item.productId} at location ${item.locationId}`,
        false,
        item.productId,
        item.locationId,
      );
    }

    // Create opening balance batch
    const batch = await tx.inventory.create({
      data: {
        productId: item.productId,
        locationId: item.locationId,
        quantity: item.quantity,
        unitCost: item.unitCost,
        receivedAt: item.receivedAt, // cutoverDate
        source: item.source,
        costSource: item.costSource,
      },
    });

    return batch;
  }

  /**
   * Main migration function: execute complete cutover process (with batch support)
   */
  async executeInventoryMigration(
    input: CutoverInput,
    approvedCosts: { productId: string; cost: Prisma.Decimal }[],
    batchSize?: number | null,
    cutoverId?: string | null,
  ): Promise<MigrationResult> {
    // Step 1: Validate input
    const validation = await this.validateCutoverInput(input);
    if (!validation.valid) {
      throw new CutoverValidationError(
        'Validation failed',
        validation.errors,
      );
    }

    // Step 2: Build approved costs map
    const approvedCostsMap = new Map<string, Prisma.Decimal>();
    for (const approvedCost of approvedCosts) {
      approvedCostsMap.set(approvedCost.productId, approvedCost.cost);
    }

    // Step 3: Get or create cutover record
    let cutoverRecord: any;
    let batchState: {
      processedProductIds: Set<string>;
      allItems: Array<{
        locationId: string;
        locationName: string;
        item: any;
      }>;
    } | null = null;

    if (cutoverId) {
      // Resume existing cutover
      cutoverRecord = await this.prisma.cutover.findUnique({
        where: { id: cutoverId },
      });
      if (!cutoverRecord) {
        throw new CutoverValidationError('Cutover not found', []);
      }
      if (cutoverRecord.status === 'COMPLETED') {
        throw new CutoverValidationError('Cutover already completed', []);
      }
      // Load batch state
      batchState = cutoverRecord.batchState as any;
    } else {
      // Create new cutover
      cutoverRecord = await this.prisma.cutover.create({
        data: {
          cutoverDate: input.cutoverDate,
          costBasis: input.costBasis,
          ownerApproved: input.ownerApproved,
          ownerApprovedAt: input.ownerApprovedAt || new Date(),
          ownerApprovedBy: input.ownerApprovedBy || null,
          status: 'PENDING',
          batchSize: batchSize || null,
          currentBatch: 0,
          totalBatches: null,
          processedItems: 0,
          totalItems: null,
        } as any,
      });
    }

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
      batchSize: batchSize || null,
      currentBatch: cutoverRecord.currentBatch || 0,
      totalBatches: cutoverRecord.totalBatches || null,
      processedItems: cutoverRecord.processedItems || 0,
      totalItems: cutoverRecord.totalItems || null,
      isComplete: false,
      canContinue: false,
    };

    // Step 4: Collect all items to process (outside transaction for batch processing)
    interface ItemToProcess {
      locationId: string;
      locationName: string;
      squareInventoryItem: any;
    }

    const itemsToProcess: ItemToProcess[] = [];
    const processedItemKeys = batchState?.processedProductIds
      ? new Set<string>(Array.from(batchState.processedProductIds))
      : new Set<string>();

    // Collect items from all locations
    for (const locationId of input.locationIds) {
      const location = await this.prisma.location.findUnique({
        where: { id: locationId },
      });

      if (!location || !location.squareId) {
        result.errors.push({
          locationId: locationId,
          errorType: 'SQUARE_API_ERROR',
          message: 'Location does not have Square ID configured',
          canProceed: false,
        });
        continue;
      }

      // Fetch Square inventory for location
      let squareInventory;
      try {
        squareInventory = await this.squareInventory.fetchSquareInventory(
          location.squareId,
        );
      } catch (error) {
        result.errors.push({
          locationId: locationId,
          locationName: location.name,
          errorType: 'SQUARE_API_ERROR',
          message: `Failed to fetch Square inventory: ${
            error instanceof Error ? error.message : String(error)
          }`,
          canProceed: false,
        });
        continue;
      }

      if (squareInventory.length === 0) {
        result.warnings.push({
          locationId: locationId,
          message: `No inventory found for location ${location.name}`,
          recommendation: 'Verify Square inventory is configured',
        });
      }

      // Add items to process list (skip already processed)
      for (const item of squareInventory) {
        const itemKey = `${locationId}:${item.catalogObjectId}`;
        if (!processedItemKeys.has(itemKey)) {
          itemsToProcess.push({
            locationId: locationId,
            locationName: location.name,
            squareInventoryItem: item,
          });
        }
      }
    }

    // Update total items if not set
    if (!cutoverRecord.totalItems) {
      await this.prisma.cutover.update({
        where: { id: cutoverRecord.id },
        data: { totalItems: itemsToProcess.length } as any,
      });
      result.totalItems = itemsToProcess.length;
    } else {
      result.totalItems = cutoverRecord.totalItems;
    }

    // Calculate batches
    // If batchSize is explicitly provided (not null/undefined), use it; otherwise process all at once
    const effectiveBatchSize = batchSize != null && batchSize > 0 
      ? batchSize 
      : itemsToProcess.length;
    const totalBatches = Math.ceil(itemsToProcess.length / effectiveBatchSize);
    const currentBatch = cutoverRecord.currentBatch || 0;
    const startIndex = currentBatch * effectiveBatchSize;
    const endIndex = Math.min(startIndex + effectiveBatchSize, itemsToProcess.length);
    const batchItems = itemsToProcess.slice(startIndex, endIndex);

    // Debug logging
    console.log(`[BATCH_PROCESSING] Total items: ${itemsToProcess.length}`);
    console.log(`[BATCH_PROCESSING] Batch size requested: ${batchSize}`);
    console.log(`[BATCH_PROCESSING] Effective batch size: ${effectiveBatchSize}`);
    console.log(`[BATCH_PROCESSING] Total batches: ${totalBatches}`);
    console.log(`[BATCH_PROCESSING] Current batch: ${currentBatch}`);
    console.log(`[BATCH_PROCESSING] Processing items ${startIndex} to ${endIndex} (${batchItems.length} items)`);

    result.batchSize = effectiveBatchSize;
    result.totalBatches = totalBatches;
    result.currentBatch = currentBatch;

    if (batchItems.length === 0) {
      // All items processed
      result.isComplete = true;
      result.canContinue = false;
      
      // Update cutover as completed
      await this.prisma.cutover.update({
        where: { id: cutoverRecord.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          result: result as any,
        },
      });

      // Lock system
      await this.enableCutoverLock(input.cutoverDate, input.locationIds, this.prisma);

      return result;
    }

    // Step 5: Process batch in transaction
    try {
      await this.prisma.$transaction(async (tx) => {
        // Process batch items
        for (const itemData of batchItems) {
          const { locationId, locationName, squareInventoryItem: item } = itemData;
          let productId: string | undefined;
          let productName: string | undefined;

          try {
            // Resolve product from Square variation
            productId = await this.catalogMapper.resolveProductFromSquareVariation(
              item.catalogObjectId,
              locationId,
            );

            const product = await tx.product.findUnique({
              where: { id: productId },
              select: {
                id: true,
                name: true,
                squareProductName: true,
                squareDescription: true,
                squareVariationName: true,
              },
            });

            if (!product) {
              result.errors.push({
                productId: productId,
                locationId: locationId,
                errorType: 'DATABASE_ERROR',
                message: `Product ${productId} does not exist`,
                canProceed: false,
              });
              continue;
            }

            productName =
              product.squareProductName ||
              product.squareVariationName ||
              product.name;

            // Determine unit cost
            const approvedCost = approvedCostsMap.get(productId);

            // Use stored data first, fallback to Square API if needed
            let productNameForExtraction =
              product.squareProductName ||
              product.squareVariationName ||
              product.name;
            let productDescriptionForExtraction: string | null =
              product.squareDescription || null;

            if (input.costBasis === 'DESCRIPTION') {
              // Only fetch from Square if stored data is missing
              if (!product.squareProductName || !product.squareDescription) {
                try {
                  const catalogObject =
                    await this.squareInventory.fetchSquareCatalogObject(
                      item.catalogObjectId,
                    );

                  if (catalogObject) {
                    const squareProductName = catalogObject.productName || null;
                    const squareVariationName =
                      catalogObject.itemVariationData?.name || null;

                    // Filter out "Sin variación"
                    const filteredSquareName =
                      squareProductName &&
                      !squareProductName
                        .toLowerCase()
                        .includes('sin variación') &&
                      !squareProductName
                        .toLowerCase()
                        .includes('no variation') &&
                      squareProductName.trim().length > 0
                        ? squareProductName
                        : null;

                    const filteredVariationName =
                      squareVariationName &&
                      !squareVariationName
                        .toLowerCase()
                        .includes('sin variación') &&
                      !squareVariationName
                        .toLowerCase()
                        .includes('no variation') &&
                      squareVariationName.trim().length > 0
                        ? squareVariationName
                        : null;

                    productNameForExtraction =
                      filteredSquareName ||
                      filteredVariationName ||
                      product.squareProductName ||
                      product.squareVariationName ||
                      product.name;
                    productDescriptionForExtraction =
                      catalogObject.productDescription ||
                      product.squareDescription;

                    // Update product with fetched data for next time
                    await tx.product.update({
                      where: { id: productId },
                      data: {
                        squareProductName:
                          filteredSquareName || product.squareProductName,
                        squareDescription:
                          catalogObject.productDescription ||
                          product.squareDescription,
                        squareVariationName:
                          filteredVariationName || product.squareVariationName,
                        squareDataSyncedAt: new Date(),
                      },
                    });
                  }
                } catch (error) {
                  console.warn(
                    `[MIGRATION] Failed to fetch catalog object for ${item.catalogObjectId}:`,
                    error,
                  );
                  // Continue with stored data or fallback
                }
              }
            }

            const unitCost = await this.determineUnitCost(
              productId,
              locationId,
              input.costBasis,
              item.catalogObjectId,
              productNameForExtraction,
              approvedCost,
              null,
              productDescriptionForExtraction,
            );

            if (unitCost === null) {
              result.errors.push({
                productId: productId,
                productName: productName,
                locationId: locationId,
                errorType: 'MISSING_COST',
                message: `Cannot determine cost for product ${productName}. Manual input required.`,
                canProceed: false,
              });
              continue;
            }

            // Create opening balance batch
            await this.createOpeningBalanceBatch(
              {
                productId: productId,
                locationId: locationId,
                quantity: item.quantity,
                unitCost: unitCost,
                receivedAt: input.cutoverDate,
                source: 'OPENING_BALANCE',
                costSource: input.costBasis,
              },
              tx,
            );

            result.openingBalancesCreated++;
            result.productsProcessed++;
            
            // Mark as processed
            const itemKey = `${locationId}:${item.catalogObjectId}`;
            processedItemKeys.add(itemKey);
          } catch (error) {
            if (error instanceof MigrationErrorClass) {
              result.errors.push({
                productId: productId,
                productName: productName,
                locationId: locationId,
                errorType: error.errorType,
                message: error.message,
                canProceed: error.canProceed,
              });
            } else {
              result.errors.push({
                productId: productId,
                productName: productName,
                locationId: locationId,
                errorType: 'DATABASE_ERROR',
                message:
                  error instanceof Error ? error.message : String(error),
                canProceed: false,
              });
            }
          }
        }

        result.locationsProcessed = input.locationIds.length;
      }); // End transaction

      // Update cutover record with batch progress
      const isLastBatch = currentBatch + 1 >= totalBatches;
      const newProcessedItems = (cutoverRecord.processedItems || 0) + batchItems.length;

      await this.prisma.cutover.update({
        where: { id: cutoverRecord.id },
        data: {
          status: isLastBatch ? 'COMPLETED' : 'IN_PROGRESS',
          currentBatch: currentBatch + 1,
          processedItems: newProcessedItems,
          totalBatches: totalBatches,
          batchState: {
            processedProductIds: Array.from(processedItemKeys),
            locationIds: input.locationIds, // Store for resuming
          } as any,
          completedAt: isLastBatch ? new Date() : null,
          result: result as any,
        } as any,
      });

      result.processedItems = newProcessedItems;
      result.currentBatch = currentBatch + 1;
      result.isComplete = isLastBatch;
      result.canContinue = !isLastBatch;

      // Lock system if this was the last batch
      if (isLastBatch) {
        await this.enableCutoverLock(input.cutoverDate, input.locationIds, this.prisma);
        result.completedAt = new Date();
      }
    } catch (error) {
      // Update cutover record as failed
      await this.prisma.cutover.update({
        where: { id: cutoverRecord.id },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          result: result as any,
        },
      });
      throw error;
    }

    return result;
  }

  /**
   * Continue batch migration from where it left off
   */
  async continueBatchMigration(
    cutoverId: string,
    approvedCosts: { productId: string; cost: Prisma.Decimal }[],
  ): Promise<MigrationResult> {
    const cutoverRecord = await this.prisma.cutover.findUnique({
      where: { id: cutoverId },
    });

    if (!cutoverRecord) {
      throw new CutoverValidationError('Cutover not found', []);
    }

    if (cutoverRecord.status === 'COMPLETED') {
      throw new CutoverValidationError('Cutover already completed', []);
    }

    if (cutoverRecord.status !== 'IN_PROGRESS') {
      throw new CutoverValidationError('Cutover is not in progress', []);
    }

    // Reconstruct input from cutover record
    const batchState = (cutoverRecord as any).batchState as any;
    const locationIds = batchState?.locationIds || [];

    if (locationIds.length === 0) {
      throw new CutoverValidationError(
        'Cannot continue batch without locationIds. Please restart migration.',
        [],
      );
    }

    const input: CutoverInput = {
      cutoverDate: cutoverRecord.cutoverDate,
      locationIds: locationIds,
      costBasis: cutoverRecord.costBasis as any,
      ownerApproved: cutoverRecord.ownerApproved,
      ownerApprovedAt: cutoverRecord.ownerApprovedAt,
      ownerApprovedBy: cutoverRecord.ownerApprovedBy,
      approvedCosts: null,
    };

    // Continue migration with same batch size
    return this.executeInventoryMigration(
      input,
      approvedCosts,
      (cutoverRecord as any).batchSize || null,
      cutoverId,
    );
  }

  /**
   * Enable system lock to prevent backdated edits after cutover
   */
  async enableCutoverLock(
    cutoverDate: Date,
    locationIds: string[],
    tx: Omit<
      PrismaClient,
      '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
    >,
  ): Promise<CutoverLock> {
    // Create lock for each location
    for (const locationId of locationIds) {
      await tx.cutoverLock.create({
        data: {
          locationId: locationId,
          cutoverDate: cutoverDate,
          isLocked: true,
          lockedAt: new Date(),
        },
      });
    }

    return {
      isLocked: true,
      lockedAt: new Date(),
      lockedBy: null,
      cutoverDate: cutoverDate,
      preventsBackdatedEdits: true,
      preventsBackdatedSales: true,
      preventsSilentCostChanges: true,
    };
  }

  /**
   * Validate that an operation is not backdated (enforce cutover lock)
   */
  async validateNoBackdatedOperation(
    operationDate: Date,
    locationId: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const cutover = await this.getCutoverForLocation(locationId);

    if (!cutover) {
      return { allowed: true };
    }

    if (operationDate < cutover.cutoverDate) {
      return {
        allowed: false,
        reason: `Operation date ${operationDate.toISOString()} is before cutover date ${cutover.cutoverDate.toISOString()}. Backdated operations are not allowed.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Get cutover information for a location
   */
  async getCutoverForLocation(locationId: string): Promise<{
    cutoverDate: Date;
  } | null> {
    const lock = await this.prisma.cutoverLock.findFirst({
      where: {
        locationId: locationId,
        isLocked: true,
      },
      orderBy: {
        cutoverDate: 'desc',
      },
    });

    if (!lock) {
      return null;
    }

    return {
      cutoverDate: lock.cutoverDate,
    };
  }

  /**
   * Preview what would be migrated without executing (dry run)
   */
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

      const products: ProductPreview[] = [];

      for (const item of squareInventory) {
        try {
          const productId = await this.catalogMapper.resolveProductFromSquareVariation(
            item.catalogObjectId,
            locationId,
          );

          const product = await this.prisma.product.findUnique({
            where: { id: productId },
            select: {
              id: true,
              name: true,
              squareProductName: true,
              squareDescription: true,
              squareVariationName: true,
            },
          });

          if (!product) {
            continue;
          }

          const approvedCost = approvedCostsMap.get(productId);

          // Use stored data first, fallback to Square API if needed
          let productNameForExtraction =
            product.squareProductName ||
            product.squareVariationName ||
            product.name;
          let productDescriptionForExtraction: string | null =
            product.squareDescription || null;

          if (input.costBasis === 'DESCRIPTION') {
            // Only fetch from Square if stored data is missing
            if (!product.squareProductName || !product.squareDescription) {
              try {
                const catalogObject =
                  await this.squareInventory.fetchSquareCatalogObject(
                    item.catalogObjectId,
                  );

                if (catalogObject) {
                  const squareProductName = catalogObject.productName || null;
                  const squareVariationName =
                    catalogObject.itemVariationData?.name || null;

                  // Filter out "Sin variación"
                  const filteredSquareName =
                    squareProductName &&
                    !squareProductName.toLowerCase().includes('sin variación') &&
                    !squareProductName.toLowerCase().includes('no variation') &&
                    squareProductName.trim().length > 0
                      ? squareProductName
                      : null;

                  const filteredVariationName =
                    squareVariationName &&
                    !squareVariationName.toLowerCase().includes('sin variación') &&
                    !squareVariationName.toLowerCase().includes('no variation') &&
                    squareVariationName.trim().length > 0
                      ? squareVariationName
                      : null;

                  productNameForExtraction =
                    filteredSquareName ||
                    filteredVariationName ||
                    product.squareProductName ||
                    product.squareVariationName ||
                    product.name;
                  productDescriptionForExtraction =
                    catalogObject.productDescription ||
                    product.squareDescription;

                  // Update product with fetched data for next time
                  await this.prisma.product.update({
                    where: { id: productId },
                    data: {
                      squareProductName:
                        filteredSquareName || product.squareProductName,
                      squareDescription:
                        catalogObject.productDescription ||
                        product.squareDescription,
                      squareVariationName:
                        filteredVariationName || product.squareVariationName,
                      squareDataSyncedAt: new Date(),
                    },
                  });
                }
              } catch (error) {
                console.warn(
                  `[PREVIEW] Failed to fetch catalog object for ${item.catalogObjectId}:`,
                  error,
                );
                // Continue with stored data or fallback
              }
            }
          }

          const unitCost = await this.determineUnitCost(
            productId,
            locationId,
            input.costBasis,
            item.catalogObjectId,
            productNameForExtraction,
            approvedCost,
            null,
            productDescriptionForExtraction,
          );

          const hasCost = unitCost !== null;

          products.push({
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
        products: products,
        totalProducts: products.length,
        productsWithCost: products.filter((p) => p.hasCost).length,
        productsMissingCost: products.filter((p) => !p.hasCost).length,
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

  /**
   * Get cutover status for a location or all locations
   */
  async getCutoverStatus(locationId?: string): Promise<{
    isLocked: boolean;
    cutoverDate?: Date | null;
    lockedAt?: Date | null;
    locations: Array<{
      locationId: string;
      locationName: string;
      isLocked: boolean;
      cutoverDate?: Date | null;
    }>;
  }> {
    if (locationId) {
      const lock = await this.prisma.cutoverLock.findFirst({
        where: {
          locationId: locationId,
          isLocked: true,
        },
        include: {
          location: true,
        },
        orderBy: {
          cutoverDate: 'desc',
        },
      });

      return {
        isLocked: !!lock,
        cutoverDate: lock?.cutoverDate || null,
        lockedAt: lock?.lockedAt || null,
        locations: lock
          ? [
              {
                locationId: locationId,
                locationName: lock.location?.name || 'Unknown',
                isLocked: true,
                cutoverDate: lock.cutoverDate,
              },
            ]
          : [],
      };
    }

    // Get all locked locations
    const locks = await this.prisma.cutoverLock.findMany({
      where: {
        isLocked: true,
      },
      include: {
        location: true,
      },
      orderBy: {
        cutoverDate: 'desc',
      },
    });

    return {
      isLocked: locks.length > 0,
      cutoverDate: locks[0]?.cutoverDate || null,
      lockedAt: locks[0]?.lockedAt || null,
      locations: locks.map((lock) => ({
        locationId: lock.locationId || 'unknown',
        locationName: lock.location?.name || 'Unknown',
        isLocked: true,
        cutoverDate: lock.cutoverDate,
      })),
    };
  }

  /**
   * Store cost approvals in database
   */
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
      effectiveAt?: Date | undefined;
    }> | null,
  ): Promise<void> {
    const effectiveDate = effectiveAt || new Date();

    // Process each approval with supplier management
    for (const ac of approvedCosts) {
      // Store cost approval
      await this.prisma.costApproval.create({
        data: {
          cutoverId: cutoverId,
          productId: ac.productId,
          approvedCost: ac.cost,
          source: ac.source,
          notes: ac.notes || null,
          approvedBy: approvedBy || null,
        },
      });

      // Handle supplier if provided
      if (ac.supplierName) {
        try {
          // Find or create supplier (ensures no duplicates)
          const supplier = await this.supplierService.findOrCreateSupplier(
            ac.supplierName,
          );

          // Create cost history
          await this.supplierService.createSupplierCostHistory(
            ac.productId,
            supplier.id,
            ac.cost,
            'MIGRATION',
            effectiveDate,
          );

          // Set as preferred if requested
          if (ac.isPreferred) {
            await this.supplierService.setPreferredSupplier(
              ac.productId,
              supplier.id,
            );
          }
        } catch (error) {
          console.error(
            `[COST_APPROVAL] Failed to create supplier/cost history for product ${ac.productId}:`,
            error,
          );
          // Continue processing other approvals even if one fails
        }
      } else if (ac.supplierId) {
        // Use existing supplier ID
        try {
          // Create cost history
          await this.supplierService.createSupplierCostHistory(
            ac.productId,
            ac.supplierId,
            ac.cost,
            'MIGRATION',
            effectiveDate,
          );

          // Set as preferred if requested
          if (ac.isPreferred) {
            await this.supplierService.setPreferredSupplier(
              ac.productId,
              ac.supplierId,
            );
          }
        } catch (error) {
          console.error(
            `[COST_APPROVAL] Failed to create cost history for product ${ac.productId}:`,
            error,
          );
        }
      }
    }

    // Process entries to add to supplier history (from extracted options)
    if (entriesToAddToHistory && entriesToAddToHistory.length > 0) {
      for (const entry of entriesToAddToHistory) {
        try {
          // Find or create supplier (ensures no duplicates)
          const supplier = await this.supplierService.findOrCreateSupplier(
            entry.supplierName,
          );

          // Create cost history for this entry
          // Use entry's effectiveAt if provided, otherwise default to one week ago
          let entryEffectiveDate: Date;
          if (entry.effectiveAt) {
            entryEffectiveDate = entry.effectiveAt;
          } else {
            // Default: one week prior to current date
            entryEffectiveDate = new Date();
            entryEffectiveDate.setDate(entryEffectiveDate.getDate() - 7);
          }
          
          await this.supplierService.createSupplierCostHistory(
            entry.productId,
            supplier.id,
            new Prisma.Decimal(entry.cost),
            'MIGRATION',
            entryEffectiveDate,
          );
        } catch (error) {
          console.error(
            `[COST_APPROVAL] Failed to add entry to supplier history for product ${entry.productId}, supplier ${entry.supplierName}:`,
            error,
          );
          // Continue processing other entries even if one fails
        }
      }
    }
  }

  /**
   * Retrieve cost approvals for a cutover
   */
  async getCostApprovals(
    cutoverId: string,
  ): Promise<{ productId: string; cost: Prisma.Decimal }[]> {
    const approvals = await this.prisma.costApproval.findMany({
      where: { cutoverId: cutoverId },
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
   * Generate UUID (simple implementation)
   */
  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

