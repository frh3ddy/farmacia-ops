import { Controller, Get, Post, HttpCode, HttpStatus, HttpException, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LocationsService } from './locations.service';
import { AuthGuard, RoleGuard, Roles, Public } from '../auth/guards/auth.guard';

@Controller()
@UseGuards(AuthGuard, RoleGuard)
export class LocationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locationsService: LocationsService,
  ) {}

  @Get()
  @Public()  // Health check is public
  async healthCheck() {
    return {
      message: 'Farmacia Ops API',
      status: 'running',
      timestamp: new Date().toISOString()
    };
  }

  @Get('locations')
  @Public()  // Locations list is public (needed for device activation)
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
  @Roles('OWNER')  // Only OWNER can sync locations from Square
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

