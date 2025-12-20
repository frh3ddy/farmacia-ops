import 'reflect-metadata';
import { config } from 'dotenv';
import { resolve } from 'path';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';

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

const port = process.env.PORT || 3000;

let app: INestApplication;

async function bootstrap() {
  console.log(`🚀 Starting Farmacia Ops API on port ${port}...`);

  app = await NestFactory.create(AppModule);

  // Configure CORS
  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  });

  await app.listen(port);
  console.log(`✅ API server listening on port ${port}`);
}

// Graceful shutdown
async function gracefulShutdown() {
  console.log('🛑 Shutting down API server...');
  if (app) {
    await app.close();
    console.log('✅ NestJS application closed');
  }
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

bootstrap().catch((error) => {
  console.error('Failed to start application:', error);
  process.exit(1);
});
