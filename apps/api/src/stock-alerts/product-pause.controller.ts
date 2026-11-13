import { BadRequestException, Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { PauseReason } from '@prisma/client';
import { AuthGuard, LocationGuard, Roles, GuardedRequest, assertActingAtOwnStore } from '../auth/guards/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from '../products/products.service';
import { pauseProduct } from './stock-pause';

/** Pausing a product per store (stock alerts O5). Each answers with the product's updated row at that store. */
@Controller('products')
@UseGuards(AuthGuard, LocationGuard)
export class ProductPauseController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
  ) {}

  /** POST /products/:id/pause { locationId, reason, note? } */
  @Post(':id/pause')
  @Roles('OWNER', 'MANAGER')
  async pause(@Param('id') productId: string, @Body() body: { locationId?: string; reason: PauseReason; note?: string }, @Req() req: GuardedRequest) {
    const locationId = body.locationId || req.currentLocation?.locationId;
    if (!locationId) throw new BadRequestException('Falta la sucursal');
    assertActingAtOwnStore(req, locationId);
    await pauseProduct(this.prisma, { productId, locationId, reason: body.reason, note: body.note, employeeId: req.employee?.id });
    return this.products.getProduct(productId, locationId);
  }
}
