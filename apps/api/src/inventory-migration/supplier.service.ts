import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class SupplierService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Normalize supplier name for matching (lowercase, trim, remove special chars)
   */
  private normalizeSupplierName(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s]/g, '') // Remove special characters
      .replace(/\s+/g, ' '); // Normalize whitespace
  }

  /**
   * Find or create supplier by name
   */
  async findOrCreateSupplier(name: string): Promise<{
    id: string;
    name: string;
    contactInfo: string | null;
    isActive: boolean;
  }> {
    if (!name || name.trim().length === 0) {
      throw new Error('Supplier name cannot be empty');
    }

    const normalizedName = this.normalizeSupplierName(name);

    // Try to find existing supplier (exact match first, then fuzzy)
    let supplier = await this.prisma.supplier.findFirst({
      where: {
        name: {
          equals: name,
          mode: 'insensitive',
        },
        isActive: true,
      },
    });

    // If not found, try normalized match
    if (!supplier) {
      const allSuppliers = await this.prisma.supplier.findMany({
        where: { isActive: true },
      });

      for (const s of allSuppliers) {
        if (this.normalizeSupplierName(s.name) === normalizedName) {
          supplier = s;
          break;
        }
      }
    }

    // Create if not found
    if (!supplier) {
      supplier = await this.prisma.supplier.create({
        data: {
          name: name.trim(),
          isActive: true,
        },
      });
    }

    return {
      id: supplier.id,
      name: supplier.name,
      contactInfo: supplier.contactInfo,
      isActive: supplier.isActive,
    };
  }

  /**
   * Suggest suppliers by search term (fuzzy matching)
   */
  async suggestSuppliers(searchTerm: string, limit: number = 10): Promise<
    Array<{
      id: string;
      name: string;
      contactInfo: string | null;
    }>
  > {
    if (!searchTerm || searchTerm.trim().length === 0) {
      // Return all active suppliers if no search term
      const suppliers = await this.prisma.supplier.findMany({
        where: { isActive: true },
        take: limit,
        orderBy: { name: 'asc' },
      });
      return suppliers.map((s) => ({
        id: s.id,
        name: s.name,
        contactInfo: s.contactInfo,
      }));
    }

    const normalizedSearch = this.normalizeSupplierName(searchTerm);

    // Get all active suppliers
    const allSuppliers = await this.prisma.supplier.findMany({
      where: { isActive: true },
    });

    // Score and sort by match quality
    const scored = allSuppliers
      .map((supplier) => {
        const normalizedName = this.normalizeSupplierName(supplier.name);
        let score = 0;

        // Exact match
        if (normalizedName === normalizedSearch) {
          score = 100;
        }
        // Starts with
        else if (normalizedName.startsWith(normalizedSearch)) {
          score = 80;
        }
        // Contains
        else if (normalizedName.includes(normalizedSearch)) {
          score = 60;
        }
        // Partial word match
        else {
          const searchWords = normalizedSearch.split(' ');
          const nameWords = normalizedName.split(' ');
          const matchingWords = searchWords.filter((sw) =>
            nameWords.some((nw) => nw.includes(sw) || sw.includes(nw)),
          );
          if (matchingWords.length > 0) {
            score = 40 * (matchingWords.length / searchWords.length);
          }
        }

        return { supplier, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => ({
        id: item.supplier.id,
        name: item.supplier.name,
        contactInfo: item.supplier.contactInfo,
      }));

    return scored;
  }

  /**
   * Create supplier cost history record
   */
  async createSupplierCostHistory(
    productId: string,
    supplierId: string,
    unitCost: Prisma.Decimal,
    source: 'MIGRATION' | 'INVENTORY_UPDATE' | 'MANUAL',
    effectiveAt: Date,
  ): Promise<void> {
    // Check if there's a current cost history for this product+supplier
    const currentHistory = await this.prisma.supplierCostHistory.findFirst({
      where: {
        productId,
        supplierId,
        isCurrent: true,
      },
    });

    // Only create history if cost differs from current cost
    if (currentHistory) {
      const costDiff = unitCost.minus(currentHistory.unitCost);
      // If cost is the same (within small tolerance), don't create new history
      if (costDiff.abs().lessThan(new Prisma.Decimal('0.01'))) {
        return;
      }

      // Mark previous as not current
      await this.prisma.supplierCostHistory.update({
        where: { id: currentHistory.id },
        data: { isCurrent: false },
      });
    }

    // Create new cost history record
    await this.prisma.supplierCostHistory.create({
      data: {
        productId,
        supplierId,
        unitCost,
        effectiveAt,
        source,
        isCurrent: true,
      },
    });
  }

  /**
   * Set preferred supplier for a product
   */
  async setPreferredSupplier(
    productId: string,
    supplierId: string,
  ): Promise<void> {
    // Unset all other preferred suppliers for this product
    await this.prisma.supplierProduct.updateMany({
      where: {
        productId,
        isPreferred: true,
      },
      data: {
        isPreferred: false,
      },
    });

    // Find or create SupplierProduct record
    const existing = await this.prisma.supplierProduct.findUnique({
      where: {
        supplierId_productId: {
          supplierId,
          productId,
        },
      },
    });

    if (existing) {
      // Update existing record
      await this.prisma.supplierProduct.update({
        where: { id: existing.id },
        data: { isPreferred: true },
      });
    } else {
      // Get current cost from cost history or use 0
      const currentCostHistory = await this.prisma.supplierCostHistory.findFirst(
        {
          where: {
            productId,
            supplierId,
            isCurrent: true,
          },
        },
      );

      const cost = currentCostHistory
        ? currentCostHistory.unitCost
        : new Prisma.Decimal(0);

      // Create new SupplierProduct record
      await this.prisma.supplierProduct.create({
        data: {
          productId,
          supplierId,
          cost,
          isPreferred: true,
        },
      });
    }
  }

  /**
   * Get all suppliers
   */
  async getAllSuppliers(): Promise<
    Array<{
      id: string;
      name: string;
      initials: string | null;
      contactInfo: string | null;
      isActive: boolean;
    }>
  > {
    const suppliers = await this.prisma.supplier.findMany({
      orderBy: { name: 'asc' },
    });

    return suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      initials: (s as any).initials,
      contactInfo: (s as any).contactInfo,
      isActive: (s as any).isActive,
    }));
  }

  /**
   * Get latest cost history date for a product and supplier
   */
  async getLatestCostHistoryDate(
    productId: string,
    supplierId: string,
  ): Promise<Date | null> {
    const latestHistory = await this.prisma.supplierCostHistory.findFirst({
      where: {
        productId,
        supplierId,
        isCurrent: true,
      },
      orderBy: {
        effectiveAt: 'desc',
      },
    });

    return latestHistory ? latestHistory.effectiveAt : null;
  }
}

