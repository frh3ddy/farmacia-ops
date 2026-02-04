import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmployeeRole } from '@prisma/client';
import * as crypto from 'crypto';

// ============================================================================
// Types
// ============================================================================

interface DeviceActivationInput {
  email: string;
  password: string;
  deviceName: string;
  locationId?: string;  // Optional - auto-selects first OWNER/MANAGER location
  deviceType?: 'FIXED' | 'MOBILE' | 'WEB';
}

interface PINLoginInput {
  pin: string;
  deviceToken: string;
}

interface SwitchLocationInput {
  locationId: string;
  sessionToken: string;
}

interface LocationAccess {
  locationId: string;
  locationName: string;
  role: EmployeeRole;
}

// ============================================================================
// Constants
// ============================================================================

const PIN_LOCKOUT_ATTEMPTS = 3;
const PIN_LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours
const DEVICE_TOKEN_PREFIX = 'dt_';
const SESSION_TOKEN_PREFIX = 'st_';

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  // --------------------------------------------------------------------------
  // Password Hashing (for device activation)
  // --------------------------------------------------------------------------
  
  private hashPassword(password: string, salt: string): string {
    return crypto
      .pbkdf2Sync(password, salt, 10000, 64, 'sha512')
      .toString('hex');
  }

  private generateSalt(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private verifyPassword(password: string, hash: string, salt: string): boolean {
    const computedHash = this.hashPassword(password, salt);
    return crypto.timingSafeEqual(
      Buffer.from(computedHash),
      Buffer.from(hash)
    );
  }

  // --------------------------------------------------------------------------
  // PIN Hashing
  // --------------------------------------------------------------------------

  hashPIN(pin: string, salt: string): string {
    return crypto
      .pbkdf2Sync(pin, salt, 10000, 32, 'sha256')
      .toString('hex');
  }

  verifyPIN(pin: string, hash: string, salt: string): boolean {
    const computedHash = this.hashPIN(pin, salt);
    return crypto.timingSafeEqual(
      Buffer.from(computedHash),
      Buffer.from(hash)
    );
  }

  // --------------------------------------------------------------------------
  // Token Generation
  // --------------------------------------------------------------------------

  private generateDeviceToken(): string {
    return `${DEVICE_TOKEN_PREFIX}${crypto.randomUUID()}`;
  }

  private generateSessionToken(): string {
    return `${SESSION_TOKEN_PREFIX}${crypto.randomUUID()}`;
  }

  // --------------------------------------------------------------------------
  // Device Activation
  // --------------------------------------------------------------------------

  async activateDevice(input: DeviceActivationInput) {
    const { email, password, deviceName, locationId: requestedLocationId, deviceType = 'FIXED' } = input;

    // Find employee by email
    const employee = await this.prisma.employee.findUnique({
      where: { email },
      include: {
        assignments: {
          where: { isActive: true },
          include: { location: true },
        },
      },
    });

    if (!employee) {
      throw new HttpException(
        { success: false, message: 'Invalid email or password' },
        HttpStatus.UNAUTHORIZED
      );
    }

    if (!employee.isActive) {
      throw new HttpException(
        { success: false, message: 'Employee account is deactivated' },
        HttpStatus.UNAUTHORIZED
      );
    }

    // Verify password
    if (!employee.passwordHash) {
      throw new HttpException(
        { success: false, message: 'Account not set up for device activation. Contact administrator.' },
        HttpStatus.UNAUTHORIZED
      );
    }

    // For password verification, we store salt in the hash (format: salt:hash)
    const [storedSalt, storedHash] = employee.passwordHash.split(':');
    if (!storedSalt || !storedHash || !this.verifyPassword(password, storedHash, storedSalt)) {
      throw new HttpException(
        { success: false, message: 'Invalid email or password' },
        HttpStatus.UNAUTHORIZED
      );
    }

    // Find valid location assignment (OWNER or MANAGER only)
    const validAssignments = employee.assignments.filter(
      a => a.isActive && ['OWNER', 'MANAGER'].includes(a.role) && a.location.isActive
    );

    if (validAssignments.length === 0) {
      throw new HttpException(
        { success: false, message: 'Only owners or managers can activate devices' },
        HttpStatus.FORBIDDEN
      );
    }

    // Determine which location to use
    let locationAssignment;
    if (requestedLocationId) {
      // User specified a location - verify they have access
      locationAssignment = validAssignments.find(a => a.locationId === requestedLocationId);
      if (!locationAssignment) {
        throw new HttpException(
          { success: false, message: 'You do not have owner/manager access to this location' },
          HttpStatus.FORBIDDEN
        );
      }
    } else {
      // Auto-select first valid location (prefer OWNER over MANAGER)
      locationAssignment = validAssignments.find(a => a.role === 'OWNER') || validAssignments[0];
    }

    const location = locationAssignment.location;
    const locationId = location.id;

    // Create device
    const deviceToken = this.generateDeviceToken();
    const device = await this.prisma.device.create({
      data: {
        locationId,
        name: deviceName,
        deviceToken,
        type: deviceType,
        activatedBy: employee.id,
      },
      include: {
        location: true,
      },
    });

    // Log the activation
    await this.logAction({
      employeeId: employee.id,
      deviceId: device.id,
      locationId,
      action: 'DEVICE_ACTIVATED',
      details: { deviceName, deviceType },
    });

    return {
      deviceToken,
      device: {
        id: device.id,
        name: device.name,
        type: device.type,
        activatedAt: device.activatedAt,
      },
      location: {
        id: location.id,
        name: location.name,
      },
      activatedBy: {
        id: employee.id,
        name: employee.name,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Device Deactivation
  // --------------------------------------------------------------------------

  async deactivateDevice(deviceId: string, employeeId: string) {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });

    if (!device) {
      throw new HttpException(
        { success: false, message: 'Device not found' },
        HttpStatus.NOT_FOUND
      );
    }

    // Check employee has OWNER access to this location
    const assignment = await this.prisma.employeeLocationAssignment.findFirst({
      where: {
        employeeId,
        locationId: device.locationId,
        role: 'OWNER',
        isActive: true,
      },
    });

    if (!assignment) {
      throw new HttpException(
        { success: false, message: 'Only owners can deactivate devices' },
        HttpStatus.FORBIDDEN
      );
    }

    // Deactivate the device
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { isActive: false },
    });

    // Invalidate all sessions for this device
    await this.prisma.employeeSession.deleteMany({
      where: { deviceToken: device.deviceToken },
    });

    // Log the deactivation
    await this.logAction({
      employeeId,
      deviceId,
      locationId: device.locationId,
      action: 'DEVICE_DEACTIVATED',
    });

    return { success: true };
  }

  // --------------------------------------------------------------------------
  // Validate Device Token
  // --------------------------------------------------------------------------

  async validateDeviceToken(deviceToken: string) {
    const device = await this.prisma.device.findUnique({
      where: { deviceToken },
      include: { location: true },
    });

    if (!device || !device.isActive) {
      throw new HttpException(
        { success: false, message: 'Invalid or deactivated device' },
        HttpStatus.UNAUTHORIZED
      );
    }

    // Update last active time
    await this.prisma.device.update({
      where: { id: device.id },
      data: { lastActiveAt: new Date() },
    });

    return device;
  }

  // --------------------------------------------------------------------------
  // PIN Login
  // --------------------------------------------------------------------------

  async loginWithPIN(input: PINLoginInput) {
    const { pin, deviceToken } = input;

    // Validate device
    const device = await this.validateDeviceToken(deviceToken);

    // Find employee by PIN at this location
    // We need to check all employees with assignments to this location
    const employees = await this.prisma.employee.findMany({
      where: {
        isActive: true,
        pin: { not: null },
        assignments: {
          some: {
            locationId: device.locationId,
            isActive: true,
          },
        },
      },
      include: {
        assignments: {
          where: { isActive: true },
          include: { location: true },
        },
      },
    });

    // Find matching employee
    let matchedEmployee = null;
    for (const employee of employees) {
      if (employee.pin && employee.pinSalt) {
        // Check lockout
        if (employee.pinLockedUntil && new Date() < employee.pinLockedUntil) {
          continue; // Skip locked employees
        }

        if (this.verifyPIN(pin, employee.pin, employee.pinSalt)) {
          matchedEmployee = employee;
          break;
        }
      }
    }

    if (!matchedEmployee) {
      // Record failed attempt for all possible employees (security measure)
      // In practice, you might want a different approach
      throw new HttpException(
        { success: false, message: 'Invalid PIN' },
        HttpStatus.UNAUTHORIZED
      );
    }

    // Check if employee is locked out
    if (matchedEmployee.pinLockedUntil && new Date() < matchedEmployee.pinLockedUntil) {
      const remainingSeconds = Math.ceil(
        (matchedEmployee.pinLockedUntil.getTime() - Date.now()) / 1000
      );
      throw new HttpException(
        {
          success: false,
          message: 'Account locked',
          lockedUntil: matchedEmployee.pinLockedUntil,
          secondsRemaining: remainingSeconds,
        },
        HttpStatus.UNAUTHORIZED
      );
    }

    // Reset failed attempts on successful login
    await this.prisma.employee.update({
      where: { id: matchedEmployee.id },
      data: {
        pinFailedAttempts: 0,
        pinLockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    // Create session
    const sessionToken = this.generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    await this.prisma.employeeSession.create({
      data: {
        employeeId: matchedEmployee.id,
        deviceToken,
        sessionToken,
        locationId: device.locationId,
        expiresAt,
      },
    });

    // Get accessible locations
    const accessibleLocations: LocationAccess[] = matchedEmployee.assignments
      .filter(a => a.isActive)
      .map(a => ({
        locationId: a.locationId,
        locationName: a.location.name,
        role: a.role,
      }));

    // Get current location assignment
    const currentAssignment = matchedEmployee.assignments.find(
      a => a.locationId === device.locationId
    );

    // Log the login
    await this.logAction({
      employeeId: matchedEmployee.id,
      deviceId: device.id,
      locationId: device.locationId,
      action: 'LOGIN',
    });

    return {
      sessionToken,
      expiresAt,
      employee: {
        id: matchedEmployee.id,
        name: matchedEmployee.name,
      },
      accessibleLocations,
      currentLocation: currentAssignment
        ? {
            locationId: currentAssignment.locationId,
            locationName: currentAssignment.location.name,
            role: currentAssignment.role,
          }
        : null,
    };
  }

  // --------------------------------------------------------------------------
  // Record Failed PIN Attempt
  // --------------------------------------------------------------------------

  async recordFailedPINAttempt(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) return;

    const newAttempts = employee.pinFailedAttempts + 1;
    const updates: any = { pinFailedAttempts: newAttempts };

    if (newAttempts >= PIN_LOCKOUT_ATTEMPTS) {
      updates.pinLockedUntil = new Date(Date.now() + PIN_LOCKOUT_DURATION_MS);
    }

    await this.prisma.employee.update({
      where: { id: employeeId },
      data: updates,
    });
  }

  // --------------------------------------------------------------------------
  // Validate Session
  // --------------------------------------------------------------------------

  async validateSession(sessionToken: string) {
    const session = await this.prisma.employeeSession.findUnique({
      where: { sessionToken },
      include: {
        employee: {
          include: {
            assignments: {
              where: { isActive: true },
              include: { location: true },
            },
          },
        },
      },
    });

    if (!session) {
      throw new HttpException(
        { success: false, message: 'Invalid session' },
        HttpStatus.UNAUTHORIZED
      );
    }

    if (new Date() > session.expiresAt) {
      // Clean up expired session
      await this.prisma.employeeSession.delete({
        where: { id: session.id },
      });
      throw new HttpException(
        { success: false, message: 'Session expired' },
        HttpStatus.UNAUTHORIZED
      );
    }

    if (!session.employee.isActive) {
      throw new HttpException(
        { success: false, message: 'Employee account deactivated' },
        HttpStatus.UNAUTHORIZED
      );
    }

    // Update last activity
    await this.prisma.employeeSession.update({
      where: { id: session.id },
      data: { lastActivityAt: new Date() },
    });

    // Get current location assignment
    const currentAssignment = session.employee.assignments.find(
      a => a.locationId === session.locationId
    );

    return {
      session,
      employee: session.employee,
      currentLocation: currentAssignment,
      accessibleLocations: session.employee.assignments,
    };
  }

  // --------------------------------------------------------------------------
  // Refresh Session
  // --------------------------------------------------------------------------

  async refreshSession(sessionToken: string) {
    const { session, employee } = await this.validateSession(sessionToken);

    // Create new session token
    const newSessionToken = this.generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    // Update session
    await this.prisma.employeeSession.update({
      where: { id: session.id },
      data: {
        sessionToken: newSessionToken,
        expiresAt,
        lastActivityAt: new Date(),
      },
    });

    return {
      sessionToken: newSessionToken,
      expiresAt,
    };
  }

  // --------------------------------------------------------------------------
  // Switch Location
  // --------------------------------------------------------------------------

  async switchLocation(input: SwitchLocationInput) {
    const { locationId, sessionToken } = input;

    const { session, employee, currentLocation } = await this.validateSession(sessionToken);

    // Check employee has access to new location
    const newAssignment = employee.assignments.find(
      a => a.locationId === locationId && a.isActive
    );

    if (!newAssignment) {
      throw new HttpException(
        { success: false, message: 'You do not have access to this location' },
        HttpStatus.FORBIDDEN
      );
    }

    // Update session location
    await this.prisma.employeeSession.update({
      where: { id: session.id },
      data: { locationId },
    });

    // Log the switch
    await this.logAction({
      employeeId: employee.id,
      locationId,
      action: 'SWITCH_LOCATION',
      details: {
        fromLocationId: currentLocation?.locationId,
        toLocationId: locationId,
      },
    });

    return {
      previousLocation: currentLocation
        ? {
            locationId: currentLocation.locationId,
            locationName: currentLocation.location.name,
            role: currentLocation.role,
          }
        : null,
      currentLocation: {
        locationId: newAssignment.locationId,
        locationName: newAssignment.location.name,
        role: newAssignment.role,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Logout
  // --------------------------------------------------------------------------

  async logout(sessionToken: string) {
    const session = await this.prisma.employeeSession.findUnique({
      where: { sessionToken },
    });

    if (session) {
      // Log before deleting
      await this.logAction({
        employeeId: session.employeeId,
        locationId: session.locationId,
        action: 'LOGOUT',
      });

      await this.prisma.employeeSession.delete({
        where: { id: session.id },
      });
    }

    return { success: true };
  }

  // --------------------------------------------------------------------------
  // Get Active Devices
  // --------------------------------------------------------------------------

  async getActiveDevices(locationId: string) {
    return this.prisma.device.findMany({
      where: {
        locationId,
        isActive: true,
      },
      orderBy: { lastActiveAt: 'desc' },
    });
  }

  // --------------------------------------------------------------------------
  // Audit Logging
  // --------------------------------------------------------------------------

  async logAction(params: {
    employeeId?: string;
    deviceId?: string;
    locationId?: string;
    action: string;
    entityType?: string;
    entityId?: string;
    details?: any;
    ipAddress?: string;
    userAgent?: string;
  }) {
    return this.prisma.auditLog.create({
      data: {
        employeeId: params.employeeId,
        deviceId: params.deviceId,
        locationId: params.locationId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        details: params.details,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
    });
  }

  // --------------------------------------------------------------------------
  // Get Audit Logs
  // --------------------------------------------------------------------------

  async getAuditLogs(options: {
    locationId?: string;
    employeeId?: string;
    action?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
  }) {
    const where: any = {};

    if (options.locationId) where.locationId = options.locationId;
    if (options.employeeId) where.employeeId = options.employeeId;
    if (options.action) where.action = options.action;
    if (options.startDate || options.endDate) {
      where.timestamp = {};
      if (options.startDate) where.timestamp.gte = options.startDate;
      if (options.endDate) where.timestamp.lte = options.endDate;
    }

    return this.prisma.auditLog.findMany({
      where,
      include: {
        employee: {
          select: { id: true, name: true },
        },
      },
      orderBy: { timestamp: 'desc' },
      take: options.limit || 100,
    });
  }

  // --------------------------------------------------------------------------
  // Clean up expired sessions (should be run periodically)
  // --------------------------------------------------------------------------

  async cleanupExpiredSessions() {
    const result = await this.prisma.employeeSession.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });

    return { deletedCount: result.count };
  }
}
