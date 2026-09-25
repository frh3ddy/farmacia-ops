import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
        version: '2025-01-23', // pinned so an SDK bump can't silently change behavior
      });
    }
    return this.squareClient;
  }

  /**
   * Fetch locations from Square API and sync to database. Square is the
   * source of truth: each location's isActive mirrors its Square status, and
   * local Square-linked locations missing from Square are pruned (see
   * pruneLocation).
   */
  async syncLocationsFromSquare(): Promise<{
    total: number;
    created: number;
    updated: number;
    removed: number;
    deactivated: number;
    errors: Array<{ locationId: string; error: string }>;
  }> {
    const client = this.getSquareClient();
    const result = {
      total: 0,
      created: 0,
      updated: 0,
      removed: 0,
      deactivated: 0,
      errors: [] as Array<{ locationId: string; error: string }>,
    };
    let squareLocations: any[] = [];

    try {
      // Fetch locations from Square
      const response = await client.locations.list();

      // Square SDK v40: response.locations contains the array
      squareLocations = (response as any).locations || [];

      result.total = squareLocations.length;

      for (const squareLocation of squareLocations) {
        try {
          const squareId = squareLocation.id;
          const isActive = squareLocation.status !== 'INACTIVE';
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
                isActive,
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
                isActive,
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

    // An empty list almost certainly means a wrong token/environment, not
    // that every store closed — never prune everything on that signal.
    if (squareLocations.length > 0) {
      const squareIds = squareLocations.map((l) => l.id).filter(Boolean);
      const stale = await this.prisma.location.findMany({
        where: { squareId: { not: null, notIn: squareIds } },
        select: { id: true },
      });
      for (const { id } of stale) {
        try {
          result[await this.pruneLocation(id)]++;
        } catch (error) {
          result.errors.push({
            locationId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return result;
  }

  /**
   * Deletes a location that no longer exists in Square — or, if it has any
   * history (sales, inventory, expenses, cutover locks… every relation but
   * CatalogMapping is ON DELETE RESTRICT), deactivates it instead so that
   * history keeps its location. One DELETE statement, so a restrict
   * violation rolls back the CatalogMapping cascade too.
   */
  private async pruneLocation(id: string): Promise<'removed' | 'deactivated'> {
    try {
      await this.prisma.location.delete({ where: { id } });
      return 'removed';
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2003') throw error;
      await this.prisma.location.update({ where: { id }, data: { isActive: false } });
      return 'deactivated';
    }
  }

  /**
   * Fetch locations directly from Square API (without saving to database)
   * Used during initial setup when user hasn't authenticated yet
   */
  async fetchSquareLocations(): Promise<{
    locations: Array<{
      squareId: string;
      name: string;
      address: string | null;
      status: string;
    }>;
  }> {
    const client = this.getSquareClient();

    try {
      const response = await client.locations.list();
      const squareLocations = (response as any).locations || [];

      return {
        locations: squareLocations.map((loc: any) => ({
          squareId: loc.id,
          name: loc.name || `Location ${loc.id}`,
          address: loc.address
            ? [
                loc.address.addressLine1,
                loc.address.addressLine2,
                loc.address.locality,
                loc.address.administrativeDistrictLevel1,
                loc.address.postalCode,
              ]
                .filter(Boolean)
                .join(', ')
            : null,
          status: loc.status || 'ACTIVE',
        })),
      };
    } catch (error) {
      throw new Error(
        `Failed to fetch locations from Square: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

