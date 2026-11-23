import { BadRequestException, Controller, ForbiddenException, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, LocationGuard, Roles, GuardedRequest } from '../auth/guards/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { purchaseNeeds } from '../inventory/purchase-needs';
import { reviewsPauseSuggestionsAt } from './pause-suggestions';

/** Por pedir (purchase-needs.ts): owners and managers, at their own store (owners any). */
@Controller('inventory/purchase-needs')
@UseGuards(AuthGuard, LocationGuard)
export class PurchaseNeedsController {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /inventory/purchase-needs?locationId= (default: the session's store) */
  @Get()
  @Roles('OWNER', 'MANAGER')
  async list(@Query('locationId') locationId: string | undefined, @Req() req: GuardedRequest) {
    const store = locationId || req.currentLocation?.locationId;
    if (!store) throw new BadRequestException('Falta la sucursal');
    if (!reviewsPauseSuggestionsAt(req, store)) throw new ForbiddenException({ success: false, message: 'Solo el dueño puede hacer esto en otras sucursales' });
    return { success: true, data: await purchaseNeeds(this.prisma, store) };
  }
}
