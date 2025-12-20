import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const connection = new IORedis(process.env.REDIS_URL!);

new Worker(
  'sales',
  async job => {
    const { payload } = job.data;

    const payment = payload.payment;
    const squareId = payment.id;
    const locationId = payment.location_id;
    console.log('payment', payment);
    // Prevent double write (extra safety)
    const existing = await prisma.sale.findUnique({
      where: { squareId },
    });
    if (existing) return;

    // TODO: fetch line items from Square Orders API
    // TODO: calculate FIFO costs
    // TODO: write Sale + SaleItems
  },
  { connection },
);