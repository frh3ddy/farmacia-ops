import { CanActivate, ForbiddenException, Injectable } from '@nestjs/common';

/** Dev tools (test sales, test inventory, resets) write or erase real data, so production refuses them. */
@Injectable()
export class NotInProduction implements CanActivate {
  canActivate() {
    if (process.env.RAILWAY_ENVIRONMENT_NAME === 'production') {
      throw new ForbiddenException('Disabled in production: this dev tool changes real stock, cost or sales.');
    }
    return true;
  }
}
