import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

type SupplierDTO = {
  id: string;
  name: string;
  initials: string[];
  contactInfo: string | null;
  isActive: boolean;
};

type SuggestDTO = {
  id: string;
  name: string;
  contactInfo: string | null;
};

@Injectable()
export class SupplierService {
  private readonly logger = new Logger(SupplierService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Normalize supplier name for matching:
   * - Unicode normalization
   * - remove combining diacritics
   * - remove non-letter/number/space characters (Unicode-aware)
   * - collapse whitespace
   */
  private normalizeSupplierName(name: string): string {
    return name
      .normalize('NFKD') // decompose accents
      .replace(/[\u0300-\u036f]/g, '') // remove diacritics
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '') // remove anything that's not letter/number/space (unicode)
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Find or create supplier by name.
   * - Uses upsert on normalizedName for race-free, atomic operations.
   * - The unique index on normalizedName ensures no duplicates.
   */
  async findOrCreateSupplier(name: string): Promise<SupplierDTO> {
    if (!name || name.trim().length === 0) {
      throw new BadRequestException('Supplier name cannot be empty');
    }
    const trimmed = name.trim();
    const normalized = this.normalizeSupplierName(trimmed);

    // Upsert by normalizedName - atomic and race-free
    const supplier = await this.prisma.supplier.upsert({
      where: {
        normalizedName: normalized,
      },
      update: {
        // If supplier exists but was deactivated, reactivate it
        isActive: true,
        // Update name if it changed (but normalizedName stays the same)
        name: trimmed,
      },
      create: {
        name: trimmed,
        normalizedName: normalized,
        isActive: true,
      },
    });

    return {
      id: supplier.id,
      name: supplier.name,
      initials: Array.isArray(supplier.initials) ? supplier.initials : (supplier.initials ? [supplier.initials] : []),
      contactInfo: supplier.contactInfo ?? null,
      isActive: supplier.isActive ?? true,
    };
  }

  /**
   * Suggest suppliers by search term (fuzzy matching).
   * - Performs a limited DB search first to avoid scanning the entire table.
   * - Then scores the narrowed candidate list in-memory.
   */
  async suggestSuppliers(searchTerm: string, limit = 10): Promise<SuggestDTO[]> {
    if (!searchTerm || searchTerm.trim().length === 0) {
      const suppliers = await this.prisma.supplier.findMany({
        where: { isActive: true },
        take: limit,
        orderBy: { name: 'asc' },
      });
      return suppliers.map((s) => ({ id: s.id, name: s.name, contactInfo: s.contactInfo ?? null }));
    }

    const normalizedSearch = this.normalizeSupplierName(searchTerm);

    // Narrow down candidates server-side (case-insensitive contains/startsWith)
    // We fetch up to a reasonable number (e.g., 200) and then score locally
    // Note: Prisma doesn't support array contains directly, so we filter in-memory
    const candidates = await this.prisma.supplier.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: searchTerm, mode: 'insensitive' } },
          { name: { startsWith: searchTerm, mode: 'insensitive' } },
        ],
      },
      take: 200,
    });

    // Filter by initials in-memory (Prisma array filter support is limited)
    const filteredCandidates = candidates.filter((s) => {
      const initials = Array.isArray(s.initials) ? s.initials : (s.initials ? [s.initials] : []);
      return initials.includes(searchTerm) || 
             initials.some(init => init.toLowerCase().includes(searchTerm.toLowerCase()));
    });

    // Score candidates (use filtered if we have initials match, otherwise use all)
    const candidatesToScore = filteredCandidates.length > 0 ? filteredCandidates : candidates;
    const scored = candidatesToScore
      .map((s) => {
        const n = this.normalizeSupplierName(s.name);
        let score = 0;

        if (n === normalizedSearch) score = 100;
        else if (n.startsWith(normalizedSearch)) score = 80;
        else if (n.includes(normalizedSearch)) score = 60;
        else {
          const searchWords = normalizedSearch.split(' ').filter(Boolean);
          const nameWords = n.split(' ').filter(Boolean);
          if (searchWords.length > 0 && nameWords.length > 0) {
            const matches = searchWords.filter((sw) =>
              nameWords.some((nw) => nw.includes(sw) || sw.includes(nw)),
            ).length;
            if (matches > 0) score = Math.round(40 * (matches / searchWords.length));
          }
        }

        return { supplier: s, score };
      })
      .filter((it) => it.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((it) => ({
        id: it.supplier.id,
        name: it.supplier.name,
        contactInfo: it.supplier.contactInfo ?? null,
      }));

    return scored;
  }

  /**
   * Create supplier cost history record (atomic).
   * Accepts unitCost as Prisma.Decimal | string | number
   */
  async createSupplierCostHistory(
    productId: string,
    supplierId: string,
    unitCost: Prisma.Decimal | number | string,
    source: 'MIGRATION' | 'INVENTORY_UPDATE' | 'MANUAL',
    effectiveAt: Date,
  ): Promise<void> {
    if (!productId || !supplierId) {
      throw new BadRequestException('productId and supplierId are required');
    }

    // Normalize unitCost to Prisma.Decimal
    const newCost = typeof unitCost === 'object' && (unitCost as any).toString
      ? unitCost as Prisma.Decimal
      : new Prisma.Decimal(String(unitCost));

    // Get current history (if any)
    const currentHistory = await this.prisma.supplierCostHistory.findFirst({
      where: {
        productId,
        supplierId,
        isCurrent: true,
      },
    });

    // If current exists and costs are within tolerance, do nothing
    if (currentHistory) {
      const curCost = currentHistory.unitCost as Prisma.Decimal;
      const costDiff = newCost.minus(curCost);
      if (costDiff.abs().lt(new Prisma.Decimal('0.01'))) {
        // difference < 0.01 — consider equal
        return;
      }
    }

    // Run update previous / create new in a single transaction
    await this.prisma.$transaction(async (tx) => {
      if (currentHistory) {
        await tx.supplierCostHistory.update({
          where: { id: currentHistory.id },
          data: { isCurrent: false },
        });
      }

      await tx.supplierCostHistory.create({
        data: {
          productId,
          supplierId,
          unitCost: newCost,
          effectiveAt,
          source,
          isCurrent: true,
        },
      });
    });
  }

  /**
   * Set preferred supplier for a product
   * - Runs updates and creates in a transaction to avoid partial state
   */
  async setPreferredSupplier(productId: string, supplierId: string): Promise<void> {
    if (!productId || !supplierId) {
      throw new BadRequestException('productId and supplierId are required');
    }

    // Fetch current cost if any
    const currentCostHistory = await this.prisma.supplierCostHistory.findFirst({
      where: { productId, supplierId, isCurrent: true },
    });

    const costValue = currentCostHistory ? currentCostHistory.unitCost : new Prisma.Decimal(0);

    await this.prisma.$transaction([
      // unset other preferred suppliers
      this.prisma.supplierProduct.updateMany({
        where: { productId, isPreferred: true },
        data: { isPreferred: false },
      }),

      // upsert supplierProduct (update if exists else create)
      this.prisma.supplierProduct.upsert({
        where: {
          supplierId_productId: {
            supplierId,
            productId,
          },
        },
        update: {
          isPreferred: true,
          cost: costValue,
        },
        create: {
          supplierId,
          productId,
          isPreferred: true,
          cost: costValue,
        },
      }),
    ]);
  }

  /**
   * Get all suppliers
   */
  async getAllSuppliers(): Promise<SupplierDTO[]> {
    const suppliers = await this.prisma.supplier.findMany({
      orderBy: { name: 'asc' },
    });

    return suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      initials: Array.isArray(s.initials) ? s.initials : (s.initials ? [s.initials] : []),
      contactInfo: s.contactInfo ?? null,
      isActive: s.isActive ?? false,
    }));
  }

  /**
   * Update supplier initials array
   */
  async updateSupplierInitials(supplierId: string, initials: string[]): Promise<void> {
    if (!supplierId) {
      throw new BadRequestException('supplierId is required');
    }

    // Validate initials array (all non-empty strings)
    const validInitials = initials
      .map((i) => i.trim())
      .filter((i) => i.length > 0);

    await this.prisma.supplier.update({
      where: { id: supplierId },
      data: { initials: validInitials as any }, // Type assertion: Prisma client types may need IDE restart to refresh
    });
  }

  /**
   * Add an initial to a supplier (by name)
   * Creates supplier if it doesn't exist
   */
  async addInitialToSupplier(supplierName: string, initial: string): Promise<void> {
    if (!supplierName || !initial) {
      throw new BadRequestException('supplierName and initial are required');
    }

    const trimmedInitial = initial.trim();
    if (trimmedInitial.length === 0) {
      throw new BadRequestException('initial cannot be empty');
    }

    // Find or create supplier
    const supplier = await this.findOrCreateSupplier(supplierName);

    // Get current initials
    const currentInitials = supplier.initials ?? [];

    // Add initial if not already present (case-sensitive)
    if (!currentInitials.includes(trimmedInitial)) {
      const updatedInitials = [...currentInitials, trimmedInitial];
      await this.updateSupplierInitials(supplier.id, updatedInitials);
    }
  }

  /**
   * Infer supplier name from an initial using learned initials map
   */
  inferSupplierNameFromInitials(
    extractedInitial: string,
    learnedInitials: Record<string, string[]>,
  ): string | null {
    if (!extractedInitial || !learnedInitials) {
      return null;
    }

    const trimmedInitial = extractedInitial.trim();
    if (trimmedInitial.length === 0) {
      return null;
    }

    // Check each supplier's initials array
    for (const [supplierName, initials] of Object.entries(learnedInitials)) {
      if (initials.includes(trimmedInitial)) {
        return supplierName;
      }
    }

    return null;
  }

  /**
   * Get latest cost history date for a product and supplier
   */
  async getLatestCostHistoryDate(productId: string, supplierId: string): Promise<Date | null> {
    if (!productId || !supplierId) return null;

    const latest = await this.prisma.supplierCostHistory.findFirst({
      where: { productId, supplierId, isCurrent: true },
      orderBy: { effectiveAt: 'desc' },
    });

    return latest ? latest.effectiveAt : null;
  }

  /**
   * Find a supplier by initial (checks if the given name is an initial of an existing supplier)
   * Returns the supplier if found, null otherwise
   */
  async findSupplierByInitial(initial: string): Promise<SupplierDTO | null> {
    if (!initial || initial.trim().length === 0) {
      return null;
    }

    const trimmedInitial = initial.trim();

    // Find all active suppliers
    const suppliers = await this.prisma.supplier.findMany({
      where: { isActive: true },
    });

    // Check if the initial matches any supplier's initials array
    for (const supplier of suppliers) {
      const initials = Array.isArray(supplier.initials) ? supplier.initials : (supplier.initials ? [supplier.initials] : []);
      if (initials.includes(trimmedInitial)) {
        return {
          id: supplier.id,
          name: supplier.name,
          initials: initials,
          contactInfo: supplier.contactInfo ?? null,
          isActive: supplier.isActive ?? true,
        };
      }
    }

    return null;
  }
}
