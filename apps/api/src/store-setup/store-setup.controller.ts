import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, LocationGuard, Roles, GuardedRequest } from '../auth/guards/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { storeSetupChecklist } from './store-setup-checklist';

/** The owner's per-store setup checklist (not the first-run `/auth/setup/*`). */
@Controller('store-setup')
@UseGuards(AuthGuard, LocationGuard)
export class StoreSetupController {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /store-setup/checklist?locationId= (default: the session's store) */
  @Get('checklist')
  @Roles('OWNER')
  async checklist(@Query('locationId') locationId: string | undefined, @Req() req: GuardedRequest) {
    const store = locationId || req.currentLocation?.locationId;
    if (!store) throw new BadRequestException('Falta la sucursal');
    return { success: true, data: await storeSetupChecklist(this.prisma, store) };
  }
}
