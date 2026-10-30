import { Controller, Post, Body, HttpCode, HttpStatus, HttpException, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles } from '../auth/guards/auth.guard';
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

/** Square catalog sync: the owner's migration tool, refused once stores have cut over. */
@Controller('admin/square/catalog')
@UseGuards(AuthGuard)
@Roles('OWNER')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async syncCatalog(@Body() body: SyncCatalogDto): Promise<SyncCatalogResponse> {
    try {
      const result = await this.catalogService.syncSquareCatalog(body.locationId || null, body.forceResync || false);
      return { success: true, result, message: 'Catálogo sincronizado' };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // The raw error (a database or Square message) goes to the log, not the screen.
      console.error('[CATALOG_SYNC] Error syncing catalog:', error instanceof Error ? error.message : error);
      throw new HttpException(
        { success: false, message: 'No se pudo sincronizar el catálogo. Intenta de nuevo.' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
