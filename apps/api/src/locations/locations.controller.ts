import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class LocationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async healthCheck() {
    return {
      message: 'Farmacia Ops API',
      status: 'running',
      timestamp: new Date().toISOString()
    };
  }

  @Get('locations')
  async getLocations() {
    const locations = await this.prisma.location.findMany({
      orderBy: { createdAt: 'desc' }
    });

    return {
      success: true,
      data: locations,
      count: locations.length
    };
  }
}

