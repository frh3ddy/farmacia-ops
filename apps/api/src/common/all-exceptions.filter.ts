import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

// Normalizes every thrown error into the { success: false, message } shape
// controllers used to hand-roll in a try/catch on every endpoint.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
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
      response.status(status).json({ success: false, message });
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
