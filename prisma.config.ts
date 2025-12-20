import { config } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// Load environment variables from .env file BEFORE using env() helper
config();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});