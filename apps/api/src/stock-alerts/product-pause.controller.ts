import { BadRequestException, Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { PauseReason } from '@prisma/client';
import { AuthGuard, LocationGuard, Roles, GuardedRequest, assertActingAtOwnStore } from '../auth/guards/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from '../products/products.service';
import { pauseProduct, pauseProducts } from './stock-pause';

/** Pausing a product per store (stock alerts O5). Each answers with the product's updated row at that store. */
@Controller('products')
@UseGuards(AuthGuard, LocationGuard)
export class ProductPauseController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
  ) {}

  /** POST /products/:id/pause { locationId, reason, note?, replacedByProductId? } */
  @Post(':id/pause')
  @Roles('OWNER', 'MANAGER')
  async pause(@Param('id') productId: string, @Body() body: { locationId?: string; reason: PauseReason; note?: string; replacedByProductId?: string }, @Req() req: GuardedRequest) {
    const locationId = body.locationId || req.currentLocation?.locationId;
    if (!locationId) throw new BadRequestException('Falta la sucursal');
    assertActingAtOwnStore(req, locationId);
    await pauseProduct(this.prisma, { productId, locationId, reason: body.reason, note: body.note, replacedByProductId: body.replacedByProductId, employeeId: req.employee?.id });
    return this.products.getProduct(productId, locationId);
  }

  /** POST /products/pause { locationId, productIds[], reason }: all or none; the rows come back in the order sent. */
  @Post('pause')
  @Roles('OWNER', 'MANAGER')
  async pauseMany(@Body() body: { locationId?: string; productIds: string[]; reason: PauseReason }, @Req() req: GuardedRequest) {
    const locationId = body.locationId || req.currentLocation?.locationId;
    if (!locationId) throw new BadRequestException('Falta la sucursal');
    assertActingAtOwnStore(req, locationId);
    await pauseProducts(this.prisma, { productIds: body.productIds, locationId, reason: body.reason, employeeId: req.employee?.id });
    const ids = [...new Set(body.productIds)];
    const { data } = await this.products.getProducts(locationId, { onlyIds: ids, limit: ids.length });
    return { success: true, data };
  }
}
