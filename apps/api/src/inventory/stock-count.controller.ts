import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, LocationGuard, Roles, RoleGuardedRequest, assertActingAtOwnStore } from '../auth/guards/auth.guard';
import { readableSync } from '../square/square-sync-reason';
import { CountLotInput, StockCountService } from './stock-count.service';

/** The store asked for (LocationGuard checked access), else the session's. */
const storeOf = (req: { currentLocation: { locationId: string } }, locationId?: string) => locationId || req.currentLocation.locationId;

/** Conteo inicial (tasks/opening-count-epic.md). The owner starts and ends it; managers count. */
@Controller('inventory/stock-counts')
@UseGuards(AuthGuard, LocationGuard)
export class StockCountController {
  constructor(private readonly counts: StockCountService) {}

  @Post()
  @Roles('OWNER')
  async start(@Body() body: { locationId?: string }, @Req() req: RoleGuardedRequest) {
    return { success: true, data: await this.counts.start(storeOf(req, body?.locationId), req.employee.id) };
  }

  @Get('active')
  @Roles('OWNER', 'MANAGER')
  async active(@Query('locationId') locationId: string | undefined, @Req() req: RoleGuardedRequest) {
    // A role is per store: a manager here may be a cashier there.
    const store = storeOf(req, locationId);
    assertActingAtOwnStore(req, store);
    return { success: true, data: await this.counts.active(store) };
  }

  @Post(':id/end')
  @Roles('OWNER')
  async end(@Param('id') id: string, @Body() body: { locationId?: string }, @Req() req: RoleGuardedRequest) {
    await this.counts.end(id, storeOf(req, body?.locationId), req.employee.id);
    return { success: true };
  }

  @Post(':id/entries')
  @Roles('OWNER', 'MANAGER')
  async recordCount(
    @Param('id') id: string,
    @Body() body: { locationId?: string; productId: string; countedQuantity: number; unitCost?: number; clientRequestId?: string; lots?: CountLotInput[]; reason?: string; notes?: string },
    @Req() req: RoleGuardedRequest,
  ) {
    const store = storeOf(req, body?.locationId);
    assertActingAtOwnStore(req, store);
    const result = await this.counts.recordCount(id, {
      locationId: store,
      productId: body.productId,
      countedQuantity: body.countedQuantity,
      unitCost: body.unitCost,
      countedBy: req.employee.id,
      clientRequestId: body.clientRequestId,
      lots: body.lots,
      reason: body.reason,
      notes: body.notes,
    });
    return { success: true, data: { ...result, squareSync: result.squareSync && readableSync(result.squareSync) } };
  }

  @Get(':id/entries')
  @Roles('OWNER', 'MANAGER')
  async entry(
    @Param('id') id: string,
    @Query('productId') productId: string,
    @Query('locationId') locationId: string | undefined,
    @Req() req: RoleGuardedRequest,
  ) {
    const store = storeOf(req, locationId);
    assertActingAtOwnStore(req, store);
    return { success: true, data: await this.counts.entry(id, store, productId) };
  }

  @Get(':id/uncounted')
  @Roles('OWNER')
  async uncounted(@Param('id') id: string, @Query('locationId') locationId: string | undefined, @Req() req: RoleGuardedRequest) {
    return { success: true, data: await this.counts.uncounted(id, storeOf(req, locationId)) };
  }

  @Post(':id/zero')
  @Roles('OWNER')
  async zero(@Param('id') id: string, @Body() body: { locationId?: string; productIds: string[] }, @Req() req: RoleGuardedRequest) {
    const productIds = Array.isArray(body?.productIds) ? body.productIds : [];
    return { success: true, data: await this.counts.zero(id, storeOf(req, body?.locationId), productIds, req.employee.id) };
  }
}
