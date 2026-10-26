import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, RoleGuard, Roles } from '../auth/guards/auth.guard';
import { CatalogService, CatalogSyncResult } from './catalog.service';

interface SyncCatalogDto {
  locationId?: string;
  forceResync?: boolean;
}

interface SyncCatalogResponse {
  success: boolean;
  result: CatalogSyncResult;
  message: string;
}

@Controller('admin/square/catalog')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OWNER', 'MANAGER')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async syncCatalog(
    @Body() body: SyncCatalogDto,
  ): Promise<SyncCatalogResponse> {
    try {
      const locationId = body.locationId || null;
      const forceResync = body.forceResync || false;

      const result = await this.catalogService.syncSquareCatalog(
        locationId,
        forceResync,
      );

      return {
        success: true,
        result,
        message: 'Catalog sync completed successfully',
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      
      console.error('[CATALOG_SYNC] Error syncing catalog:', errorMessage);

      throw new HttpException(
        {
          success: false,
          message: `Catalog sync failed: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

