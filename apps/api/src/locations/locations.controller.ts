import { Controller, Get, Post, HttpCode, HttpStatus, HttpException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LocationsService } from './locations.service';

@Controller()
export class LocationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locationsService: LocationsService,
  ) {}

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

  @Post('locations/sync')
  @HttpCode(HttpStatus.OK)
  async syncLocations() {
    try {
      const result = await this.locationsService.syncLocationsFromSquare();
      return {
        success: true,
        result: result,
        message: `Synced ${result.total} locations: ${result.created} created, ${result.updated} updated`,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      
      throw new HttpException(
        {
          success: false,
          message: `Failed to sync locations: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

