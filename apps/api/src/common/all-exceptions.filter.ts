import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

// Normalizes every thrown error into the { success: false, message } shape
// controllers used to hand-roll in a try/catch on every endpoint.

// Error fields clients act on (a stable `code`, lockout timing). Whitelisted so
// nothing else an exception body carries leaks into the response.
const APP_FIELDS = ['code', 'lockedUntil', 'secondsRemaining'] as const;

function appFields(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return {};
  return Object.fromEntries(APP_FIELDS.filter((k) => k in body).map((k) => [k, (body as Record<string, unknown>)[k]]));
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'object' && body !== null && 'message' in body
          ? (body as { message: unknown }).message
          : typeof body === 'string'
            ? body
            : exception.message;
      if ([HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, HttpStatus.TOO_MANY_REQUESTS].includes(status)) {
        // Refused requests leave a trace (OWASP A09). Never log headers: they carry the tokens.
        const request = host.switchToHttp().getRequest<Request & { employee?: { id: string } }>();
        this.logger.warn(
          `[ACCESS] ${status} ${request.method} ${request.path} employee=${request.employee?.id ?? '-'} ip=${request.ip}: ${message}`,
        );
      }
      response.status(status).json({ success: false, message, ...appFields(body) });
      return;
    }

    const status =
      exception && typeof exception === 'object' && 'status' in exception
        ? (exception as { status: number }).status
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = exception instanceof Error ? exception.message : String(exception);
    response.status(status).json({ success: false, message });
  }
}
