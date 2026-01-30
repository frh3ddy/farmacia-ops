-- ============================================================================
-- Phase F: Multi-Location Authentication System
-- Adds Device, Employee, EmployeeLocationAssignment, EmployeeSession, AuditLog
-- ============================================================================

-- Create DeviceType enum
CREATE TYPE "DeviceType" AS ENUM ('FIXED', 'MOBILE');

-- Create EmployeeRole enum
CREATE TYPE "EmployeeRole" AS ENUM ('OWNER', 'MANAGER', 'CASHIER', 'ACCOUNTANT');

-- Create Device table
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deviceToken" TEXT NOT NULL,
    "type" "DeviceType" NOT NULL DEFAULT 'FIXED',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastActiveAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedBy" TEXT NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- Create Employee table
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT,
    "pin" TEXT,
    "pinSalt" TEXT,
    "pinFailedAttempts" INTEGER NOT NULL DEFAULT 0,
    "pinLockedUntil" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- Create EmployeeLocationAssignment table
CREATE TABLE "EmployeeLocationAssignment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "role" "EmployeeRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT,

    CONSTRAINT "EmployeeLocationAssignment_pkey" PRIMARY KEY ("id")
);

-- Create EmployeeSession table
CREATE TABLE "EmployeeSession" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceToken" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeSession_pkey" PRIMARY KEY ("id")
);

-- Create AuditLog table
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT,
    "deviceId" TEXT,
    "locationId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- Create unique constraints
CREATE UNIQUE INDEX "Device_deviceToken_key" ON "Device"("deviceToken");
CREATE UNIQUE INDEX "Employee_email_key" ON "Employee"("email");
CREATE UNIQUE INDEX "EmployeeLocationAssignment_employeeId_locationId_key" ON "EmployeeLocationAssignment"("employeeId", "locationId");
CREATE UNIQUE INDEX "EmployeeSession_sessionToken_key" ON "EmployeeSession"("sessionToken");

-- Create indexes for Device
CREATE INDEX "Device_deviceToken_idx" ON "Device"("deviceToken");
CREATE INDEX "Device_locationId_idx" ON "Device"("locationId");

-- Create indexes for Employee
CREATE INDEX "Employee_email_idx" ON "Employee"("email");
CREATE INDEX "Employee_isActive_idx" ON "Employee"("isActive");

-- Create indexes for EmployeeLocationAssignment
CREATE INDEX "EmployeeLocationAssignment_employeeId_idx" ON "EmployeeLocationAssignment"("employeeId");
CREATE INDEX "EmployeeLocationAssignment_locationId_idx" ON "EmployeeLocationAssignment"("locationId");
CREATE INDEX "EmployeeLocationAssignment_role_idx" ON "EmployeeLocationAssignment"("role");

-- Create indexes for EmployeeSession
CREATE INDEX "EmployeeSession_sessionToken_idx" ON "EmployeeSession"("sessionToken");
CREATE INDEX "EmployeeSession_employeeId_idx" ON "EmployeeSession"("employeeId");
CREATE INDEX "EmployeeSession_deviceToken_idx" ON "EmployeeSession"("deviceToken");
CREATE INDEX "EmployeeSession_expiresAt_idx" ON "EmployeeSession"("expiresAt");

-- Create indexes for AuditLog
CREATE INDEX "AuditLog_employeeId_idx" ON "AuditLog"("employeeId");
CREATE INDEX "AuditLog_locationId_idx" ON "AuditLog"("locationId");
CREATE INDEX "AuditLog_timestamp_idx" ON "AuditLog"("timestamp");
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- Add foreign key constraints
ALTER TABLE "Device" ADD CONSTRAINT "Device_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmployeeLocationAssignment" ADD CONSTRAINT "EmployeeLocationAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeLocationAssignment" ADD CONSTRAINT "EmployeeLocationAssignment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmployeeSession" ADD CONSTRAINT "EmployeeSession_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
