import { BadRequestException, Body, ForbiddenException, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { PauseSuggestionKind } from '@prisma/client';
import { AuthGuard, LocationGuard, Roles, GuardedRequest } from '../auth/guards/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { dismissPauseSuggestions, pauseSuggestions, reviewsPauseSuggestionsAt } from './pause-suggestions';

/** Pause suggestions (stock alerts O7): owners and managers, at their own store. Pausing one is POST /products/pause. */
@Controller('inventory/pause-suggestions')
@UseGuards(AuthGuard, LocationGuard)
export class PauseSuggestionsController {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /inventory/pause-suggestions?locationId=&page=&limit= (50 a page, up to 200), paged like GET /products. */
  @Get()
  @Roles('OWNER', 'MANAGER')
  async list(@Query('locationId') queryLocationId: string | undefined, @Query('page') page: string | undefined, @Query('limit') limit: string | undefined, @Req() req: GuardedRequest) {
    const locationId = this.storeOf(queryLocationId, req);
    const result = await pauseSuggestions(this.prisma, locationId, { page: Number(page) || undefined, limit: Number(limit) || undefined });
    const totalPages = Math.ceil(result.totalCount / result.limit);
    return {
      success: true,
      data: result.data,
      count: result.data.length,
      page: result.page,
      limit: result.limit,
      totalCount: result.totalCount,
      totalPages,
      hasMore: result.page < totalPages,
      windowDays: result.windowDays,
    };
  }

  /** POST /inventory/pause-suggestions/dismiss { locationId, items[{ productId, kind }] } (1–200; sending one again restarts its window). */
  @Post('dismiss')
  @Roles('OWNER', 'MANAGER')
  async dismiss(@Body() body: { locationId?: string; items: Array<{ productId: string; kind: PauseSuggestionKind }> }, @Req() req: GuardedRequest) {
    const locationId = this.storeOf(body?.locationId, req);
    await dismissPauseSuggestions(this.prisma, { locationId, items: body?.items, employeeId: req.employee?.id });
    return { success: true };
  }

  private storeOf(locationId: string | undefined, req: GuardedRequest): string {
    const store = locationId || req.currentLocation?.locationId;
    if (!store) throw new BadRequestException('Falta la sucursal');
    if (!reviewsPauseSuggestionsAt(req, store)) {
      throw new ForbiddenException({ success: false, message: 'Solo el dueño puede hacer esto en otras sucursales' });
    }
    return store;
  }
}
