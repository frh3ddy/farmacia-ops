import { SquareClient, SquareEnvironment } from 'square';

/**
 * Lazy initialization of Square client (only when needed)
 */
let squareClient: SquareClient | null = null;

export function getSquareClient(): SquareClient {
  if (!squareClient) {
    const squareAccessToken = process.env.SQUARE_ACCESS_TOKEN?.trim();
    
    if (!squareAccessToken) {
      throw new Error('SQUARE_ACCESS_TOKEN environment variable is not set');
    }

    // Determine Square environment: use Sandbox for staging/dev, Production otherwise
    let squareEnvironment: SquareEnvironment;
    const nodeEnv = process.env.NODE_ENV?.toLowerCase();
    const railwayEnv = process.env.RAILWAY_ENVIRONMENT?.toLowerCase();
    const squareEnv = process.env.SQUARE_ENVIRONMENT?.toLowerCase();

    if (
      squareEnv === 'sandbox' ||
      nodeEnv === 'development' ||
      nodeEnv === 'dev' ||
      railwayEnv === 'staging' ||
      railwayEnv === 'development'
    ) {
      squareEnvironment = SquareEnvironment.Sandbox;
    } else if (squareEnv === 'production') {
      squareEnvironment = SquareEnvironment.Production;
    } else {
      // Default to Production for safety
      squareEnvironment = SquareEnvironment.Production;
    }

    squareClient = new SquareClient({
      token: squareAccessToken,
      environment: squareEnvironment,
      version: '2025-01-23', // pinned so an SDK bump can't silently change behavior
    });
  }
  return squareClient;
}
