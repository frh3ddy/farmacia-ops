import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  HttpException,
  BadRequestException,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ProductsService, CreateProductInput, UpdatePriceInput } from './products.service';
import { CatalogSearchService } from './catalog-search.service';
import { ReferenceDataService } from './reference-data.service';
import { findOrCreateActiveIngredient, findOrCreateMedicationDefinition } from './medication-definition';
import { findOrCreateLaboratory } from './laboratory';
import { AuthGuard, RoleGuard, LocationGuard, Roles } from '../auth/guards/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { PharmaceuticalForm, AdministrationRoute, PackagingType } from '@prisma/client';

// DTOs
interface CreateProductDto {
  name: string;
  sku?: string;
  description?: string;
  sellingPrice: number;
  costPrice?: number;
  initialStock?: number;
  supplierId?: string; // Supplier the initial stock came from
  locationId?: string; // Optional - will use current location if not provided
  syncToSquare?: boolean;
  categoryId?: string;
  labId?: string;
  labName?: string; // find-or-create by name when labId isn't already known
  medicationType?: 'GENERIC' | 'BRAND' | 'SIMILAR';
  presentation?: string;
  requiresPrescription?: boolean;
  isControlled?: boolean;
  // Derived naming/presentación inputs (see derived-naming.ts) — resolved
  // name/presentation win over these when set.
  primaryPackaging?: PackagingType;
  secondaryPackaging?: PackagingType;
  quantity?: number;
  primaryContent?: number;
  manualName?: string;
  manualPresentation?: string;
  // Sueltos: links this (box) product to its already-existing loose Product.
  looseProductId?: string;
  // Brand-name search tags, e.g. a generic's known brand names.
  searchAliases?: string[];
  // Either an existing definition id, or enough inline info to find-or-create one.
  medicationDefinitionId?: string;
  medication?: {
    name: string;
    form: PharmaceuticalForm;
    route: AdministrationRoute;
    strength: string;
    activeIngredients: { name: string; concentrationValue?: number; concentrationUnit?: string }[];
  };
}

interface UpdatePriceDto {
  sellingPrice: number;
  locationId?: string;
  syncToSquare?: boolean;
  applyToAllLocations?: boolean;  // If true, update price at all Square locations
}

// Multer memory storage — files are never written to disk.
// The buffer is sent directly to Square and the Square-hosted URL is stored.
const productImageMemoryStorage = memoryStorage();

const imageFileFilter = (_req: any, file: any, cb: any) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new HttpException('Only image files are allowed', HttpStatus.BAD_REQUEST), false);
  }
};

@Controller('products')
@UseGuards(AuthGuard, RoleGuard, LocationGuard)
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly prisma: PrismaService,
    private readonly catalogSearchService: CatalogSearchService,
    private readonly referenceDataService: ReferenceDataService,
  ) {}

  /**
   * Create a new product
   * POST /products
   * Roles: OWNER, MANAGER
   */
  @Post()
  @Roles('OWNER', 'MANAGER')
  @HttpCode(HttpStatus.CREATED)
  async createProduct(@Body() body: CreateProductDto, @Req() req: any) {
    // Validate required fields
    if (!body.name || body.name.trim().length === 0) {
      throw new HttpException(
        { success: false, message: 'Product name is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (body.sellingPrice === undefined || body.sellingPrice === null) {
      throw new HttpException(
        { success: false, message: 'Selling price is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Use provided locationId or current location
    const locationId = body.locationId || req.currentLocation?.locationId;
    if (!locationId) {
      throw new HttpException(
        { success: false, message: 'Location ID is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Resolve the laboratory: either an existing id, or a name to find-or-create.
    const labId = body.labId || (body.labName ? await findOrCreateLaboratory(this.prisma, body.labName) : undefined);

    // Resolve the medication definition: either an id already picked from
    // the search/picker, or inline ingredient/strength/form/route info that
    // gets resolved to an existing (or newly created) definition here.
    let medicationDefinitionId = body.medicationDefinitionId;
    if (!medicationDefinitionId && body.medication) {
      const ingredients = await Promise.all(
        body.medication.activeIngredients.map(async (i) => ({
          activeIngredientId: await findOrCreateActiveIngredient(this.prisma, i.name),
          concentrationValue: i.concentrationValue,
          concentrationUnit: i.concentrationUnit,
        })),
      );
      medicationDefinitionId = await findOrCreateMedicationDefinition(this.prisma, {
        name: body.medication.name,
        form: body.medication.form,
        route: body.medication.route,
        strength: body.medication.strength,
        ingredients,
      });
    }

    const input: CreateProductInput = {
      name: body.name,
      sku: body.sku,
      description: body.description,
      sellingPrice: body.sellingPrice,
      costPrice: body.costPrice,
      initialStock: body.initialStock,
      supplierId: body.supplierId,
      locationId,
      syncToSquare: body.syncToSquare !== false, // Default true
      categoryId: body.categoryId,
      labId,
      medicationType: body.medicationType,
      medicationDefinitionId,
      presentation: body.presentation,
      requiresPrescription: body.requiresPrescription,
      isControlled: body.isControlled,
      primaryPackaging: body.primaryPackaging,
      secondaryPackaging: body.secondaryPackaging,
      quantity: body.quantity,
      primaryContent: body.primaryContent,
      manualName: body.manualName,
      manualPresentation: body.manualPresentation,
      looseProductId: body.looseProductId,
      searchAliases: body.searchAliases,
    };

    const result = await this.productsService.createProduct(input);

    return {
      success: true,
      message: result.message,
      data: {
        product: result.product,
        squareSynced: result.squareSynced,
        squareItemId: result.squareItemId,
        squareVariationId: result.squareVariationId,
        inventoryCreated: result.inventoryCreated,
      },
    };
  }

  /**
   * Sync all local-only products to Square
   * POST /products/sync-to-square
   * Roles: OWNER, MANAGER
   */
  @Post('sync-to-square')
  @Roles('OWNER', 'MANAGER')
  async syncToSquare(@Body() body: any, @Req() req: any) {
    const locationId = body.locationId || req.currentLocation?.locationId;
    if (!locationId) {
      throw new BadRequestException('Location ID is required');
    }

    const result = await this.productsService.syncUnsyncedProducts(locationId);
    return {
      success: true,
      message: `Synced ${result.synced}/${result.total} products to Square${result.failed > 0 ? ` (${result.failed} failed)` : ''}`,
      data: result,
    };
  }

  /**
   * Catalog search: brand/generic/active-ingredient/SKU lookup, with generic
   * alternatives surfaced when the requested brand is out of stock.
   * GET /products/catalog-search?q=...&locationId=...
   * NOTE: Must be BEFORE @Get(':id') so "catalog-search" is not captured as an id param.
   */
  @Get('catalog-search')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async catalogSearch(@Query('q') q: string, @Query('locationId') locationId: string, @Req() req: any) {
    const targetLocationId = locationId || req.currentLocation?.locationId;
    const result = await this.catalogSearchService.search(q || '', targetLocationId);
    return { success: true, ...result };
  }

  /**
   * List active ingredients (for the medication picker on Add Product)
   * GET /products/active-ingredients
   * NOTE: Must be BEFORE @Get(':id') so "active-ingredients" is not captured as an id param.
   */
  @Get('active-ingredients')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async listActiveIngredients() {
    const activeIngredients = await this.prisma.activeIngredient.findMany({
      select: { id: true, name: true, aliases: true },
      orderBy: { name: 'asc' },
    });
    return { success: true, activeIngredients };
  }

  /**
   * Suggest brand names / active ingredients from the static Mexican-pharmacy
   * reference dataset, for Add Product autocomplete — e.g. typing "Tempra"
   * suggests paracetamol + Analgésicos y antipiréticos; typing "paracetamol"
   * suggests known brand names to add as search-alias tags.
   * GET /products/reference-suggestions?brandName=&ingredient=
   * NOTE: Must be BEFORE @Get(':id') so "reference-suggestions" is not captured as an id param.
   */
  @Get('reference-suggestions')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async getReferenceSuggestions(@Query('brandName') brandName?: string, @Query('ingredient') ingredient?: string) {
    return {
      success: true,
      brandMatches: brandName ? this.referenceDataService.suggestByBrandName(brandName) : [],
      ingredientMatches: ingredient ? this.referenceDataService.suggestByIngredient(ingredient) : [],
    };
  }

  /**
   * List categories (flat, with parentId for building the category/subcategory cascade)
   * GET /products/categories
   * NOTE: Must be BEFORE @Get(':id') so "categories" is not captured as an id param.
   */
  @Get('categories')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async listCategories() {
    const categories = await this.prisma.category.findMany({
      select: { id: true, name: true, parentId: true, symptomKeywords: true },
      orderBy: { name: 'asc' },
    });
    return { success: true, categories };
  }

  /**
   * Set (replace) a category's symptom search keywords (e.g. "fiebre",
   * "gripa" -> Analgésicos y antipiréticos), so typing a symptom in catalog
   * search surfaces products in that category. Roles: OWNER, MANAGER
   */
  @Patch('categories/:id/symptom-keywords')
  @Roles('OWNER', 'MANAGER')
  async setCategorySymptomKeywords(@Param('id') id: string, @Body() body: { symptomKeywords: string[] }) {
    const category = await this.productsService.setCategorySymptomKeywords(id, body.symptomKeywords ?? []);
    return { success: true, data: { category } };
  }

  /**
   * List laboratories/manufacturers
   * GET /products/laboratories
   * NOTE: Must be BEFORE @Get(':id') so "laboratories" is not captured as an id param.
   */
  @Get('laboratories')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async listLaboratories() {
    const laboratories = await this.prisma.laboratory.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return { success: true, laboratories };
  }

  /**
   * Get products (supports pagination)
   * GET /products
   * Roles: All authenticated users
   *
   * Query params:
   *   locationId  - target location (falls back to current)
   *   page        - 1-based page number (default 1)
   *   limit       - items per page (default 50, max 200)
   *   search      - optional name/SKU search term
   *
   * Response shape:
   *   { success, data, count, page, limit, totalCount, totalPages, hasMore }
   */
  @Get()
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async getProducts(
    @Query('locationId') locationId: string,
    @Query('page') pageStr: string,
    @Query('limit') limitStr: string,
    @Query('search') search: string,
    @Query('exact') exact: string,
    @Req() req: any,
  ) {
    // Use query param or current location
    const targetLocationId = locationId || req.currentLocation?.locationId;

    // Parse pagination params with sensible defaults
    const page = Math.max(1, parseInt(pageStr, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(limitStr, 10) || 50));

    const result = await this.productsService.getProducts(targetLocationId, {
      page,
      limit,
      search: search?.trim() || undefined,
      exact: exact === 'true',
    });
    return result;
  }

  /**
   * Upload or replace product image
   * POST /products/:id/image
   * Roles: OWNER, MANAGER
   * Accepts multipart/form-data with an "image" field
   */
  @Post(':id/image')
  @Roles('OWNER', 'MANAGER')
  @UseInterceptors(
    FileInterceptor('image', {
      storage: productImageMemoryStorage,
      fileFilter: imageFileFilter,
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    }),
  )
  async uploadProductImage(
    @Param('id') productId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file || !file.buffer) {
      throw new HttpException(
        { success: false, message: 'No image file provided' },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Send the in-memory buffer directly to Square — no disk writes
    const result = await this.productsService.uploadProductImage(
      productId,
      file.buffer,
      file.mimetype,
    );

    return {
      success: true,
      imageUrl: result.imageUrl,
      squareSynced: result.squareSynced,
      squareImageId: result.squareImageId,
      message: result.message,
    };
  }

  /**
   * Get all products available from a specific supplier (for purchase orders / shopping list)
   * GET /products/supplier-catalog/:supplierId
   * Returns products with current cost, stock levels, and preferred status
   */
  @Get('supplier-catalog/:supplierId')
  @Roles('OWNER', 'MANAGER')
  async getSupplierCatalog(
    @Param('supplierId') supplierId: string,
    @Query('locationId') locationId: string,
    @Req() req: any,
  ) {
    const targetLocationId = locationId || req.currentLocation?.locationId;

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

    const products = supplierProducts.map((sp) => {
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

    return { success: true, products };
  }

  /**
   * Get suppliers for a product (from SupplierProduct table)
   * GET /products/:id/suppliers
   * Returns current cost per supplier, preferred status, and notes
   */
  @Get(':id/suppliers')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async getProductSuppliers(@Param('id') productId: string) {
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

    const suppliers = supplierProducts.map((sp) => ({
      id: sp.supplier.id,
      name: sp.supplier.name,
      contactInfo: sp.supplier.contactInfo,
      isActive: sp.supplier.isActive,
      cost: sp.cost.toString(),
      isPreferred: sp.isPreferred,
      notes: sp.notes,
    }));

    return { success: true, suppliers };
  }

  /**
   * Get cost history for a product across all suppliers (from SupplierCostHistory table)
   * GET /products/:id/cost-history
   * Returns cost timeline grouped by supplier
   */
  @Get(':id/cost-history')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async getProductCostHistory(@Param('id') productId: string) {
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
    const suppliers = Array.from(groupedBySupplier.entries()).map(([supplierId, history]) => {
      const firstEntry = costHistories.find((e) => e.supplierId === supplierId);
      return {
        supplierId,
        supplierName: firstEntry?.supplier.name || 'Unknown',
        costHistory: history,
      };
    });

    return { success: true, suppliers };
  }

  /**
   * Lightweight stock/margin alert counts for a location
   * GET /products/counts?locationId=...
   * Roles: All authenticated users
   * NOTE: Must be BEFORE @Get(':id') so "counts" is not captured as an id param.
   */
  @Get('counts')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async getProductCounts(
    @Query('locationId') locationId: string,
    @Req() req: any,
  ) {
    const targetLocationId = locationId || req.currentLocation?.locationId;
    const result = await this.productsService.getProductCounts(targetLocationId);
    return result;
  }

  /**
   * Get single product
   * GET /products/:id
   * Roles: All authenticated users
   * NOTE: Must be AFTER /products/:id/suppliers and /products/:id/cost-history
   * to prevent :id from catching those sub-routes
   */
  @Get(':id')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async getProduct(
    @Param('id') id: string,
    @Query('locationId') locationId: string,
    @Req() req: any,
  ) {
    const targetLocationId = locationId || req.currentLocation?.locationId;
    const result = await this.productsService.getProduct(id, targetLocationId);
    return result;
  }

  /**
   * Update product price
   * PATCH /products/:id/price
   * Roles: OWNER, MANAGER
   */
  @Patch(':id/price')
  @Roles('OWNER', 'MANAGER')
  async updatePrice(
    @Param('id') id: string,
    @Body() body: UpdatePriceDto,
    @Req() req: any,
  ) {
    if (body.sellingPrice === undefined || body.sellingPrice === null) {
      throw new HttpException(
        { success: false, message: 'Selling price is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const locationId = body.locationId || req.currentLocation?.locationId;
    if (!locationId) {
      throw new HttpException(
        { success: false, message: 'Location ID is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const input: UpdatePriceInput = {
      productId: id,
      sellingPrice: body.sellingPrice,
      locationId,
      syncToSquare: body.syncToSquare !== false,
      applyToAllLocations: body.applyToAllLocations === true,
    };

    const result = await this.productsService.updatePrice(input);

    return {
      success: true,
      message: result.message,
      data: {
        product: result.product,
        previousPrice: result.previousPrice,
        newPrice: result.newPrice,
        squareSynced: result.squareSynced,
      },
    };
  }

  /**
   * Link an already-existing box product to its already-existing loose
   * counterpart, so break-bulk (POST /inventory/break-bulk) knows where
   * converted stock goes. Pass looseProductId: null to remove the link.
   * quantity (base units per box) is also settable here since break-bulk
   * needs both — pass it if the product doesn't already have one set.
   * Roles: OWNER, MANAGER
   */
  @Patch(':id/loose-link')
  @Roles('OWNER', 'MANAGER')
  async setLooseProductLink(
    @Param('id') id: string,
    @Body() body: { looseProductId: string | null; quantity?: number },
  ) {
    const product = await this.productsService.setLooseProductLink(id, body.looseProductId, body.quantity);
    return { success: true, data: { product } };
  }

  /**
   * Set a product's brand-name search tags (e.g. a generic tagged with the
   * brand names customers ask for), so catalog search surfaces it even
   * when no branded Product exists at all. Replaces the full list.
   * Roles: OWNER, MANAGER
   */
  @Patch(':id/search-aliases')
  @Roles('OWNER', 'MANAGER')
  async setSearchAliases(@Param('id') id: string, @Body() body: { searchAliases: string[] }) {
    const product = await this.productsService.setSearchAliases(id, body.searchAliases ?? []);
    return { success: true, data: { product } };
  }
}
