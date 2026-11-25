import { BadRequestException, Body, Controller, ForbiddenException, Get, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, LocationGuard, Roles, GuardedRequest } from '../auth/guards/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { reviewsPauseSuggestionsAt } from './pause-suggestions';
import { StockAlertSettingsPatch, stockAlertSettingsOf, updateStockAlertSettings } from './stock-alert-settings';

/** A store's stock alert settings: owners and managers read their store's (owners any), only owners change them. */
@Controller('inventory/stock-alert-settings')
@UseGuards(AuthGuard, LocationGuard)
export class StockAlertSettingsController {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /inventory/stock-alert-settings?locationId= (default: the session's store) */
  @Get()
  @Roles('OWNER', 'MANAGER')
  async get(@Query('locationId') locationId: string | undefined, @Req() req: GuardedRequest) {
    const store = locationId || req.currentLocation?.locationId;
    if (!store) throw new BadRequestException('Falta la sucursal');
    if (!reviewsPauseSuggestionsAt(req, store)) throw new ForbiddenException({ success: false, message: 'Solo el dueño puede hacer esto en otras sucursales' });
    return { success: true, data: await stockAlertSettingsOf(this.prisma, store) };
  }

  /** PATCH /inventory/stock-alert-settings { locationId?, coverDays?, windowDays?, noSalesMinDays?, …, receivingLocationId?, receivingReviewed? } — receiving choices mark it reviewed business-wide */
  @Patch()
  @Roles('OWNER')
  async update(@Body() body: StockAlertSettingsPatch & { locationId?: string }, @Req() req: GuardedRequest) {
    const store = body?.locationId || req.currentLocation?.locationId;
    if (!store) throw new BadRequestException('Falta la sucursal');
    return { success: true, data: await updateStockAlertSettings(this.prisma, store, body, req.employee.id) };
  }
}
