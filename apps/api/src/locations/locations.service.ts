import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SquareClient, SquareEnvironment } from 'square';

@Injectable()
export class LocationsService {
  private squareClient: SquareClient | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get or create Square client
   */
  private getSquareClient(): SquareClient {
    if (!this.squareClient) {
      const squareAccessToken = process.env.SQUARE_ACCESS_TOKEN?.trim();

      if (!squareAccessToken) {
        throw new Error(
          'SQUARE_ACCESS_TOKEN environment variable is not set',
        );
      }

      // Determine Square environment: use Sandbox for staging/dev, Production otherwise
      let squareEnvironment: SquareEnvironment;
      const nodeEnv = process.env.NODE_ENV?.toLowerCase();
      const railwayEnv = process.env.RAILWAY_ENVIRONMENT?.toLowerCase();
      const squareEnv = process.env.SQUARE_ENVIRONMENT?.toLowerCase();

      if (
        squareEnv === 'sandbox' ||
        nodeEnv === 'development' ||
        nodeEnv === 'dev' ||
        railwayEnv === 'staging' ||
        railwayEnv === 'development'
      ) {
        squareEnvironment = SquareEnvironment.Sandbox;
      } else if (squareEnv === 'production') {
        squareEnvironment = SquareEnvironment.Production;
      } else {
        // Default to Production for safety
        squareEnvironment = SquareEnvironment.Production;
      }

      this.squareClient = new SquareClient({
        token: squareAccessToken,
        environment: squareEnvironment,
      });
    }
    return this.squareClient;
  }

  /**
   * Fetch locations from Square API and sync to database
   */
  async syncLocationsFromSquare(): Promise<{
    total: number;
    created: number;
    updated: number;
    errors: Array<{ locationId: string; error: string }>;
  }> {
    const client = this.getSquareClient();
    const result = {
      total: 0,
      created: 0,
      updated: 0,
      errors: [] as Array<{ locationId: string; error: string }>,
    };

    try {
      // Fetch locations from Square
      const response = await client.locations.list();

      // Square SDK v40: response.locations contains the array
      const squareLocations = (response as any).locations || [];

      result.total = squareLocations.length;

      for (const squareLocation of squareLocations) {
        try {
          const squareId = squareLocation.id;
          const name = squareLocation.name || `Location ${squareId}`;
          const address = squareLocation.address
            ? [
                squareLocation.address.addressLine1,
                squareLocation.address.addressLine2,
                squareLocation.address.locality,
                squareLocation.address.administrativeDistrictLevel1,
                squareLocation.address.postalCode,
                squareLocation.address.country,
              ]
                .filter(Boolean)
                .join(', ')
            : null;

          // Check if location exists
          const existing = await this.prisma.location.findUnique({
            where: { squareId: squareId },
          });

          if (existing) {
            // Update existing location
            await this.prisma.location.update({
              where: { squareId: squareId },
              data: {
                name: name,
                address: address,
                isActive: true, // Ensure it's active
              },
            });
            result.updated++;
          } else {
            // Create new location
            await this.prisma.location.create({
              data: {
                squareId: squareId,
                name: name,
                address: address,
                isActive: true,
              },
            });
            result.created++;
          }
        } catch (error) {
          result.errors.push({
            locationId: squareLocation.id || 'unknown',
            error:
              error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to fetch locations from Square: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return result;
  }
}

