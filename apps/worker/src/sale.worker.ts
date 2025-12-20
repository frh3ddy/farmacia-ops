import { Job } from 'bullmq';
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

export async function processSaleJob(job: Job) {
  const { payload } = job.data;

  // Square webhook events have the object in data.object
  // For payment.created events, payload.object contains the Payment object
  const payment = payload?.object;
  
  if (!payment) {
    throw new Error(`Missing payment object in payload. Payload: ${JSON.stringify(payload)}`);
  }

  if (!payment.id) {
    throw new Error(`Payment object missing id. Payment: ${JSON.stringify(payment)}`);
  }

  const squareId = payment.id;
  const locationId = payment.location_id;
  console.log('Processing payment:', { squareId, locationId });
  
  // Prevent double write (extra safety)
  const existing = await prisma.sale.findUnique({
    where: { squareId },
  });
  if (existing) {
    console.log(`Sale ${squareId} already exists, skipping`);
    return;
  }

  // TODO: fetch line items from Square Orders API
  // TODO: calculate FIFO costs
  // TODO: write Sale + SaleItems
}