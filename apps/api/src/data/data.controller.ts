import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('api')
export class DataController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('catalog/mappings')
  async getCatalogMappings() {
    const mappings = await this.prisma.catalogMapping.findMany({
      include: {
        product: true,
        location: true,
      },
      orderBy: {
        syncedAt: 'desc',
      },
    });

    return {
      success: true,
      data: mappings,
      count: mappings.length,
    };
  }

  @Get('products')
  async getProducts() {
    const products = await this.prisma.product.findMany({
      include: {
        category: true,
        catalogMappings: {
          include: {
            location: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      success: true,
      data: products,
      count: products.length,
    };
  }

  @Get('sales')
  async getSales() {
    const sales = await this.prisma.sale.findMany({
      include: {
        items: {
          include: {
            product: true,
          },
        },
        location: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      success: true,
      data: sales,
      count: sales.length,
    };
  }

  @Get('inventory')
  async getInventory() {
    const inventory = await this.prisma.inventory.findMany({
      include: {
        product: true,
        location: true,
      },
      orderBy: {
        receivedAt: 'asc', // FIFO order
      },
    });

    return {
      success: true,
      data: inventory,
      count: inventory.length,
    };
  }
}

