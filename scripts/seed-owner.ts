/**
 * Seed script to create initial owner and location for testing
 * 
 * Usage: npx ts-node scripts/seed-owner.ts
 */

import { config } from 'dotenv';
// Load .env BEFORE importing PrismaClient
config();

import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

// Simple password hashing (matches auth.service.ts)
function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(password, salt, 10000, 64, 'sha512')
    .toString('hex');
  return { hash, salt };
}

function hashPIN(pin: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(pin, salt, 10000, 64, 'sha512')
    .toString('hex');
  return { hash, salt };
}

async function main() {
  console.log('🌱 Seeding database...\n');

  // 1. Create Location
  const location = await prisma.location.upsert({
    where: { id: 'loc_main' },
    update: {},
    create: {
      id: 'loc_main',
      squareId: 'SQUARE_LOCATION_ID', // Replace with real Square location ID if needed
      name: 'Main Pharmacy',
      address: '123 Main Street, City, State 12345',
      isActive: true,
    },
  });
  console.log('✅ Location created:', location.name);

  // 2. Create Owner Employee
  const { hash: passwordHash, salt: passwordSalt } = hashPassword('owner123');
  const { hash: pinHash, salt: pinSalt } = hashPIN('1234');

  const owner = await prisma.employee.upsert({
    where: { id: 'emp_owner' },
    update: {},
    create: {
      id: 'emp_owner',
      name: 'Store Owner',
      email: 'owner@farmacia.com',
      passwordHash: `${passwordHash}:${passwordSalt}`, // Store as hash:salt
      pin: pinHash,
      pinSalt: pinSalt,
      isActive: true,
    },
  });
  console.log('✅ Owner created:', owner.name, `(${owner.email})`);

  // 3. Assign Owner to Location
  const assignment = await prisma.employeeLocationAssignment.upsert({
    where: {
      employeeId_locationId: {
        employeeId: owner.id,
        locationId: location.id,
      },
    },
    update: {},
    create: {
      employeeId: owner.id,
      locationId: location.id,
      role: 'OWNER',
      isActive: true,
    },
  });
  console.log('✅ Owner assigned to location with role:', assignment.role);

  // 4. Create a test Cashier
  const { hash: cashierPinHash, salt: cashierPinSalt } = hashPIN('5678');
  
  const cashier = await prisma.employee.upsert({
    where: { id: 'emp_cashier' },
    update: {},
    create: {
      id: 'emp_cashier',
      name: 'Test Cashier',
      email: 'cashier@farmacia.com',
      pin: cashierPinHash,
      pinSalt: cashierPinSalt,
      isActive: true,
    },
  });
  console.log('✅ Cashier created:', cashier.name);

  await prisma.employeeLocationAssignment.upsert({
    where: {
      employeeId_locationId: {
        employeeId: cashier.id,
        locationId: location.id,
      },
    },
    update: {},
    create: {
      employeeId: cashier.id,
      locationId: location.id,
      role: 'CASHIER',
      isActive: true,
    },
  });
  console.log('✅ Cashier assigned to location');

  console.log('\n========================================');
  console.log('🎉 Seed completed successfully!\n');
  console.log('📋 Test Credentials:');
  console.log('----------------------------------------');
  console.log('DEVICE ACTIVATION (Owner):');
  console.log('  Email:    owner@farmacia.com');
  console.log('  Password: owner123');
  console.log('');
  console.log('PIN LOGIN (Owner):');
  console.log('  PIN: 1234');
  console.log('');
  console.log('PIN LOGIN (Cashier):');
  console.log('  PIN: 5678');
  console.log('----------------------------------------');
  console.log('Location ID:', location.id);
  console.log('========================================\n');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
