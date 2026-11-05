import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, LocationGuard, Roles, RoleGuardedRequest, assertActingAtOwnStore } from '../auth/guards/auth.guard';
import { StockCountService } from './stock-count.service';

/** A product's lots at a store (tasks/opening-count-lots-epic.md), for the count form to pre-fill. */
@Controller('inventory/lots')
@UseGuards(AuthGuard, LocationGuard)
export class InventoryLotsController {
  constructor(private readonly counts: StockCountService) {}

  @Get()
  @Roles('OWNER', 'MANAGER')
  async lots(@Query('productId') productId: string, @Query('locationId') locationId: string | undefined, @Req() req: RoleGuardedRequest) {
    const store = locationId || req.currentLocation.locationId;
    assertActingAtOwnStore(req, store);
    return { success: true, data: await this.counts.lots(productId, store) };
  }
}
