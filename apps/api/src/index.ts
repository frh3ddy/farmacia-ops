import { config } from 'dotenv';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { resolve, join } from 'path';
// @ts-ignore - PrismaClient is exported but TypeScript may not resolve it immediately after generation
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// Load .env file from project root
// __dirname in compiled code will be apps/api/dist, so we need to go up 3 levels to reach root
const envPath = resolve(__dirname, '../../../.env');
const result = config({ path: envPath });
if (result.error && !process.env.DATABASE_URL) {
  console.warn(`Warning: Could not load .env from ${envPath}:`, result.error.message);
  console.warn('Trying alternative path...');
  // Fallback: try loading from current working directory
  config();
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const port = process.env.PORT || 3000;

console.log(`🚀 Starting Farmacia Ops API on port ${port}...`);

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // Set CORS headers
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS for CORS
  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    // Health check endpoint
    if (url === '/' && method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        message: 'Farmacia Ops API',
        status: 'running',
        timestamp: new Date().toISOString()
      }));
      return;
    }

    // GET /locations endpoint
    if (url === '/locations' && method === 'GET') {
      const locations = await prisma.location.findMany({
        orderBy: { createdAt: 'desc' }
      });

      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        data: locations,
        count: locations.length
      }));
      return;
    }

    // 404 for unknown routes
    res.writeHead(404);
    res.end(JSON.stringify({
      success: false,
      error: 'Not Found',
      message: `Route ${method} ${url} not found`
    }));
  } catch (error) {
    console.error('Error handling request:', error);
    res.writeHead(500);
    res.end(JSON.stringify({
      success: false,
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Unknown error'
    }));
  }
}

const server = createServer(handleRequest);

server.listen(port, () => {
  console.log(`✅ API server listening on port ${port}`);
});

// Graceful shutdown
async function gracefulShutdown() {
  console.log('🛑 Shutting down API server...');
  server.close(async () => {
    try {
      await prisma.$disconnect();
      console.log('✅ Prisma client disconnected');
      process.exit(0);
    } catch (error) {
      console.error('Error disconnecting Prisma:', error);
      process.exit(1);
    }
  });
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
