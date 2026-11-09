import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { sameToken } from '../auth.service';

/**
 * Lets only the worker through: the `x-worker-secret` header must equal the
 * api's WORKER_API_SECRET. With no secret configured, every call is refused.
 */
@Injectable()
export class WorkerSecretGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.WORKER_API_SECRET;
    const sent = context.switchToHttp().getRequest().headers['x-worker-secret'];
    if (!secret || !sameToken(typeof sent === 'string' ? sent : undefined, secret)) {
      throw new HttpException({ success: false, message: 'Worker secret required' }, HttpStatus.UNAUTHORIZED);
    }
    return true;
  }
}
