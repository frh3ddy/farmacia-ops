import { Body, Controller, HttpException, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { WorkerSecretGuard } from '../auth/guards/worker-secret.guard';
import { BreakBulkService } from './break-bulk.service';

interface CoverLooseDto {
  locationId: string;
  looseProductId: string;
  needed: number;
  requestKey: string;
}

/** Routes only the worker calls (worker secret, no staff session). */
@Controller('internal/inventory')
@UseGuards(WorkerSecretGuard)
export class InternalBreakBulkController {
  constructor(private readonly breakBulk: BreakBulkService) {}

  /** Open just enough linked boxes for a sale that needs `needed` sueltos (see BreakBulkService.coverLoose). */
  @Post('cover-loose')
  async cover(@Body() body: CoverLooseDto) {
    const { locationId, looseProductId, needed, requestKey } = body ?? ({} as CoverLooseDto);
    const text = (v: unknown) => typeof v === 'string' && v.length > 0;
    if (!text(locationId) || !text(looseProductId) || !text(requestKey) || !Number.isInteger(needed) || needed <= 0) {
      throw new HttpException({ success: false, message: 'locationId, looseProductId, requestKey and a whole needed > 0 are required' }, HttpStatus.BAD_REQUEST);
    }
    const data = await this.breakBulk.coverLoose({ locationId, looseProductId, needed, requestKey, syncToSquare: true });
    return { success: true, data };
  }
}
