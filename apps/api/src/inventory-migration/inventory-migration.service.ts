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

@Injectable()
export class InventoryMigrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly squareInventory: SquareInventoryService,
    private readonly costExtraction: CostExtractionService,
    private readonly catalogMapper: CatalogMapperService,
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
    if (input.costBasis === 'DESCRIPTION') {
      if (!input.approvedCosts || input.approvedCosts.length === 0) {
        errors.push(
          'Cost extraction must be approved before migration when using DESCRIPTION cost basis',
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors,
    };
  }

  /**
   * Extract costs from all products for migration preview and approval
   */
  async extractCostsForMigration(
    locationIds: string[],
    costBasis: 'DESCRIPTION',
  ): Promise<CostApprovalRequest> {
    const extractionResults: CostExtractionResult[] = [];
    let productsWithExtraction = 0;
    let productsRequiringManualInput = 0;

    // Fetch all products for specified locations
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

      // Fetch catalog objects to get product names
      for (const item of squareInventory) {
        try {
          // Resolve product
          const productId = await this.catalogMapper.resolveProductFromSquareVariation(
            item.catalogObjectId,
            locationId,
          );

          const product = await this.prisma.product.findUnique({
            where: { id: productId },
          });

          if (!product) {
            continue;
          }

          // Fetch catalog object for product name
          const catalogObject =
            await this.squareInventory.fetchSquareCatalogObject(
              item.catalogObjectId,
            );
          const productName =
            catalogObject?.itemVariationData?.name || product.name;

          // Extract costs
          const extractionResult = this.costExtraction.extractCostFromDescription(
            productName,
          );
          const fullResult: CostExtractionResult = {
            ...extractionResult,
            productId: productId,
            productName: product.name,
            originalDescription: productName,
          };

          extractionResults.push(fullResult);

          if (extractionResult.extractedEntries.length > 0) {
            productsWithExtraction++;
          } else {
            productsRequiringManualInput++;
          }
        } catch (error) {
          // Log error, continue processing
          console.error(
            `[COST_EXTRACTION] Error processing item ${item.catalogObjectId}:`,
            error,
          );
          continue;
        }
      }
    }

    return {
      cutoverId: this.generateUUID(),
      locationIds: locationIds,
      costBasis: costBasis,
      extractionResults: extractionResults,
      totalProducts: extractionResults.length,
      productsWithExtraction: productsWithExtraction,
      productsRequiringManualInput: productsRequiringManualInput,
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
          this.costExtraction.extractCostFromDescription(productName);
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
   * Main migration function: execute complete cutover process
   */
  async executeInventoryMigration(
    input: CutoverInput,
    approvedCosts: { productId: string; cost: Prisma.Decimal }[],
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

    // Step 3: Initialize result
    const result: MigrationResult = {
      cutoverId: this.generateUUID(),
      cutoverDate: input.cutoverDate,
      locationsProcessed: 0,
      productsProcessed: 0,
      openingBalancesCreated: 0,
      errors: [],
      warnings: [],
      completedAt: new Date(),
      completedBy: input.ownerApprovedBy || null,
    };

    // Step 4: Create cutover record
    const cutoverRecord = await this.prisma.cutover.create({
      data: {
        cutoverDate: input.cutoverDate,
        costBasis: input.costBasis,
        ownerApproved: input.ownerApproved,
        ownerApprovedAt: input.ownerApprovedAt || new Date(),
        ownerApprovedBy: input.ownerApprovedBy || null,
        status: 'PENDING',
      },
    });

    result.cutoverId = cutoverRecord.id;

    // Step 5: Begin database transaction
    try {
      await this.prisma.$transaction(async (tx) => {
        // Step 6: Process each location
      for (const locationId of input.locationIds) {
        const location = await tx.location.findUnique({
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

        // Step 6: Fetch Square inventory for location
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

        // Step 7: Process each inventory item
        for (const item of squareInventory) {
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

            productName = product.name;

            // Determine unit cost
            const approvedCost = approvedCostsMap.get(productId);

            // Fetch catalog object for product name if needed
            let productNameForExtraction = productName;
            if (input.costBasis === 'DESCRIPTION') {
              const catalogObject =
                await this.squareInventory.fetchSquareCatalogObject(
                  item.catalogObjectId,
                );
              productNameForExtraction =
                catalogObject?.itemVariationData?.name || productName;
            }

            const unitCost = await this.determineUnitCost(
              productId,
              locationId,
              input.costBasis,
              item.catalogObjectId,
              productNameForExtraction,
              approvedCost,
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

        result.locationsProcessed++;
      }

      // Step 8: Check if migration can proceed
      const criticalErrors = result.errors.filter((e) => !e.canProceed);
      if (criticalErrors.length > 0) {
        throw new MigrationErrorClass(
          'MIGRATION_BLOCKED',
          `Migration blocked by ${criticalErrors.length} critical errors`,
          false,
        );
      }

        // Step 9: Lock system (prevent backdated edits)
        await this.enableCutoverLock(input.cutoverDate, input.locationIds, tx);

        // Step 10: Record cutover completion
        result.completedAt = new Date();
      }); // End transaction

      // Update cutover record as completed
      await this.prisma.cutover.update({
        where: { id: cutoverRecord.id },
        data: {
          status: 'COMPLETED',
          completedAt: result.completedAt,
          result: result as any, // Store MigrationResult as JSON
        },
      });
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
          });

          if (!product) {
            continue;
          }

          const approvedCost = approvedCostsMap.get(productId);

          let productNameForExtraction = product.name;
          if (input.costBasis === 'DESCRIPTION') {
            const catalogObject =
              await this.squareInventory.fetchSquareCatalogObject(
                item.catalogObjectId,
              );
            productNameForExtraction =
              catalogObject?.itemVariationData?.name || product.name;
          }

          const unitCost = await this.determineUnitCost(
            productId,
            locationId,
            input.costBasis,
            item.catalogObjectId,
            productNameForExtraction,
            approvedCost,
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
    }>,
    approvedBy?: string | null,
  ): Promise<void> {
    await this.prisma.costApproval.createMany({
      data: approvedCosts.map((ac) => ({
        cutoverId: cutoverId,
        productId: ac.productId,
        approvedCost: ac.cost,
        source: ac.source,
        notes: ac.notes || null,
        approvedBy: approvedBy || null,
      })),
      skipDuplicates: true,
    });
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

