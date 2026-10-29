import { Logger } from '@nestjs/common';
import { SquareClient, SquareEnvironment } from 'square';

const logger = new Logger('SquareClient');

/**
 * Sandbox when SQUARE_ENVIRONMENT=sandbox, when NODE_ENV is development/dev, or
 * on a Railway staging/development environment — any one of them wins over
 * SQUARE_ENVIRONMENT=production, so a dev machine or staging can't touch real
 * stock, sales or payroll. Production otherwise.
 */
export function squareEnvironment(env: NodeJS.ProcessEnv = process.env): SquareEnvironment {
  const squareEnv = env.SQUARE_ENVIRONMENT?.toLowerCase();
  const nodeEnv = env.NODE_ENV?.toLowerCase();
  const railwayEnv = env.RAILWAY_ENVIRONMENT?.toLowerCase();
  const isSandbox =
    squareEnv === 'sandbox' ||
    nodeEnv === 'development' ||
    nodeEnv === 'dev' ||
    railwayEnv === 'staging' ||
    railwayEnv === 'development';
  return isSandbox ? SquareEnvironment.Sandbox : SquareEnvironment.Production;
}

/** A Square client for the configured environment, or null without SQUARE_ACCESS_TOKEN. */
export function createSquareClient(): SquareClient | null {
  const token = process.env.SQUARE_ACCESS_TOKEN?.trim();
  if (!token) {
    logger.warn('SQUARE_ACCESS_TOKEN not set');
    return null;
  }
  const environment = squareEnvironment();
  logger.log(`Initializing Square client: ${environment === SquareEnvironment.Sandbox ? 'SANDBOX' : 'PRODUCTION'}`);
  return new SquareClient({
    token,
    environment,
    version: '2026-09-16', // pinned so an SDK bump can't silently change behavior
  });
}
