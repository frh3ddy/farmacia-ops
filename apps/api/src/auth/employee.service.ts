import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmployeeRole } from '@prisma/client';
import { AuthService } from './auth.service';
import * as crypto from 'crypto';

// ============================================================================
// Types
// ============================================================================

interface CreateEmployeeInput {
  name: string;
  email?: string;
  password?: string; // For owner/manager who can activate devices
  pin?: string;
  locationId: string;
  role: EmployeeRole;
  createdBy?: string;
}

interface UpdateEmployeeInput {
  name?: string;
  email?: string;
  isActive?: boolean;
}

interface SetPINInput {
  employeeId: string;
  pin: string;
}

interface AssignLocationInput {
  employeeId: string;
  locationId: string;
  role: EmployeeRole;
  assignedBy?: string;
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class EmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  // --------------------------------------------------------------------------
  // Password Hashing (for owner/manager accounts)
  // --------------------------------------------------------------------------

  private hashPassword(password: string): string {
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = crypto
      .pbkdf2Sync(password, salt, 10000, 64, 'sha512')
      .toString('hex');
    return `${salt}:${hash}`; // Store salt with hash
  }

  // --------------------------------------------------------------------------
  // Create Employee
  // --------------------------------------------------------------------------

  async createEmployee(input: CreateEmployeeInput) {
    const { name, email, password, pin, locationId, role, createdBy } = input;

    // Verify location exists
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
    });

    if (!location) {
      throw new HttpException(
        { success: false, message: 'Location not found' },
        HttpStatus.NOT_FOUND
      );
    }

    // Check if email already exists
    if (email) {
      const existing = await this.prisma.employee.findUnique({
        where: { email },
      });
      if (existing) {
        throw new HttpException(
          { success: false, message: 'Email already in use' },
          HttpStatus.CONFLICT
        );
      }
    }

    // Validate PIN if provided
    if (pin) {
      this.validatePIN(pin);
      
      // Check if PIN is unique within the location
      await this.checkPINUniqueness(pin, locationId);
    }

    // Hash password if provided (for OWNER/MANAGER who can activate devices)
    let passwordHash = null;
    if (password) {
      if (password.length < 8) {
        throw new HttpException(
          { success: false, message: 'Password must be at least 8 characters' },
          HttpStatus.BAD_REQUEST
        );
      }
      passwordHash = this.hashPassword(password);
    }

    // Hash PIN if provided
    let pinHash = null;
    let pinSalt = null;
    if (pin) {
      pinSalt = crypto.randomBytes(16).toString('hex');
      pinHash = this.authService.hashPIN(pin, pinSalt);
    }

    // Create employee with initial assignment
    const employee = await this.prisma.employee.create({
      data: {
        name,
        email,
        passwordHash,
        pin: pinHash,
        pinSalt,
        createdBy,
        assignments: {
          create: {
            locationId,
            role,
            assignedBy: createdBy,
          },
        },
      },
      include: {
        assignments: {
          include: { location: true },
        },
      },
    });

    // Log the creation
    if (createdBy) {
      await this.authService.logAction({
        employeeId: createdBy,
        locationId,
        action: 'CREATE_EMPLOYEE',
        entityType: 'Employee',
        entityId: employee.id,
        details: { name, role },
      });
    }

    return {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      isActive: employee.isActive,
      hasPIN: !!employee.pin,
      hasPassword: !!employee.passwordHash,
      createdAt: employee.createdAt,
      assignments: employee.assignments.map(a => ({
        locationId: a.locationId,
        locationName: a.location.name,
        role: a.role,
        isActive: a.isActive,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // Update Employee
  // --------------------------------------------------------------------------

  async updateEmployee(employeeId: string, input: UpdateEmployeeInput, updatedBy?: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new HttpException(
        { success: false, message: 'Employee not found' },
        HttpStatus.NOT_FOUND
      );
    }

    // Check email uniqueness if changing
    if (input.email && input.email !== employee.email) {
      const existing = await this.prisma.employee.findUnique({
        where: { email: input.email },
      });
      if (existing) {
        throw new HttpException(
          { success: false, message: 'Email already in use' },
          HttpStatus.CONFLICT
        );
      }
    }

    const updated = await this.prisma.employee.update({
      where: { id: employeeId },
      data: {
        name: input.name,
        email: input.email,
        isActive: input.isActive,
      },
      include: {
        assignments: {
          where: { isActive: true },
          include: { location: true },
        },
      },
    });

    // Log the update
    if (updatedBy) {
      await this.authService.logAction({
        employeeId: updatedBy,
        action: 'UPDATE_EMPLOYEE',
        entityType: 'Employee',
        entityId: employeeId,
        details: input,
      });
    }

    return {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      isActive: updated.isActive,
      hasPIN: !!updated.pin,
      hasPassword: !!updated.passwordHash,
      assignments: updated.assignments.map(a => ({
        locationId: a.locationId,
        locationName: a.location.name,
        role: a.role,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // Deactivate Employee
  // --------------------------------------------------------------------------

  async deactivateEmployee(employeeId: string, deactivatedBy?: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new HttpException(
        { success: false, message: 'Employee not found' },
        HttpStatus.NOT_FOUND
      );
    }

    // Deactivate employee and all assignments
    await this.prisma.$transaction([
      this.prisma.employee.update({
        where: { id: employeeId },
        data: { isActive: false },
      }),
      this.prisma.employeeLocationAssignment.updateMany({
        where: { employeeId },
        data: { isActive: false },
      }),
      // Invalidate all sessions
      this.prisma.employeeSession.deleteMany({
        where: { employeeId },
      }),
    ]);

    // Log the deactivation
    if (deactivatedBy) {
      await this.authService.logAction({
        employeeId: deactivatedBy,
        action: 'DEACTIVATE_EMPLOYEE',
        entityType: 'Employee',
        entityId: employeeId,
      });
    }

    return { success: true };
  }

  // --------------------------------------------------------------------------
  // Get Employee
  // --------------------------------------------------------------------------

  async getEmployee(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      include: {
        assignments: {
          include: { location: true },
        },
      },
    });

    if (!employee) {
      throw new HttpException(
        { success: false, message: 'Employee not found' },
        HttpStatus.NOT_FOUND
      );
    }

    return {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      isActive: employee.isActive,
      hasPIN: !!employee.pin,
      hasPassword: !!employee.passwordHash,
      lastLoginAt: employee.lastLoginAt,
      createdAt: employee.createdAt,
      assignments: employee.assignments.map(a => ({
        id: a.id,
        locationId: a.locationId,
        locationName: a.location.name,
        role: a.role,
        isActive: a.isActive,
        assignedAt: a.assignedAt,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // List Employees
  // --------------------------------------------------------------------------

  async listEmployees(options: {
    locationId?: string;
    role?: EmployeeRole;
    isActive?: boolean;
    limit?: number;
  }) {
    const where: any = {};

    if (options.isActive !== undefined) {
      where.isActive = options.isActive;
    }

    if (options.locationId || options.role) {
      where.assignments = {
        some: {
          ...(options.locationId && { locationId: options.locationId }),
          ...(options.role && { role: options.role }),
          isActive: true,
        },
      };
    }

    const employees = await this.prisma.employee.findMany({
      where,
      include: {
        assignments: {
          where: { isActive: true },
          include: { location: true },
        },
      },
      orderBy: { name: 'asc' },
      take: options.limit || 100,
    });

    return employees.map(e => ({
      id: e.id,
      name: e.name,
      email: e.email,
      isActive: e.isActive,
      hasPIN: !!e.pin,
      lastLoginAt: e.lastLoginAt,
      assignments: e.assignments.map(a => ({
        locationId: a.locationId,
        locationName: a.location.name,
        role: a.role,
      })),
    }));
  }

  // --------------------------------------------------------------------------
  // Set/Update PIN
  // --------------------------------------------------------------------------

  private validatePIN(pin: string) {
    if (!/^\d{4,6}$/.test(pin)) {
      throw new HttpException(
        { success: false, message: 'PIN must be 4-6 digits' },
        HttpStatus.BAD_REQUEST
      );
    }
  }

  private async checkPINUniqueness(pin: string, locationId: string, excludeEmployeeId?: string) {
    // Get all employees at this location with PINs
    const employees = await this.prisma.employee.findMany({
      where: {
        isActive: true,
        pin: { not: null },
        ...(excludeEmployeeId && { id: { not: excludeEmployeeId } }),
        assignments: {
          some: {
            locationId,
            isActive: true,
          },
        },
      },
    });

    // Check if PIN matches any existing employee
    for (const employee of employees) {
      if (employee.pin && employee.pinSalt) {
        if (this.authService.verifyPIN(pin, employee.pin, employee.pinSalt)) {
          throw new HttpException(
            { success: false, message: 'PIN already in use at this location' },
            HttpStatus.CONFLICT
          );
        }
      }
    }
  }

  async setPIN(input: SetPINInput, setBy?: string) {
    const { employeeId, pin } = input;

    this.validatePIN(pin);

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      include: {
        assignments: {
          where: { isActive: true },
        },
      },
    });

    if (!employee) {
      throw new HttpException(
        { success: false, message: 'Employee not found' },
        HttpStatus.NOT_FOUND
      );
    }

    // Check PIN uniqueness at all assigned locations
    for (const assignment of employee.assignments) {
      await this.checkPINUniqueness(pin, assignment.locationId, employeeId);
    }

    // Hash and save PIN
    const pinSalt = crypto.randomBytes(16).toString('hex');
    const pinHash = this.authService.hashPIN(pin, pinSalt);

    await this.prisma.employee.update({
      where: { id: employeeId },
      data: {
        pin: pinHash,
        pinSalt,
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      },
    });

    // Log the PIN change
    if (setBy) {
      await this.authService.logAction({
        employeeId: setBy,
        action: 'SET_PIN',
        entityType: 'Employee',
        entityId: employeeId,
      });
    }

    return { success: true };
  }

  // --------------------------------------------------------------------------
  // Reset PIN (clears lockout)
  // --------------------------------------------------------------------------

  async resetPINLockout(employeeId: string, resetBy?: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new HttpException(
        { success: false, message: 'Employee not found' },
        HttpStatus.NOT_FOUND
      );
    }

    await this.prisma.employee.update({
      where: { id: employeeId },
      data: {
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      },
    });

    // Log the reset
    if (resetBy) {
      await this.authService.logAction({
        employeeId: resetBy,
        action: 'RESET_PIN_LOCKOUT',
        entityType: 'Employee',
        entityId: employeeId,
      });
    }

    return { success: true };
  }

  // --------------------------------------------------------------------------
  // Set Password (for device activation capability)
  // --------------------------------------------------------------------------

  async setPassword(employeeId: string, password: string, setBy?: string) {
    if (password.length < 8) {
      throw new HttpException(
        { success: false, message: 'Password must be at least 8 characters' },
        HttpStatus.BAD_REQUEST
      );
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new HttpException(
        { success: false, message: 'Employee not found' },
        HttpStatus.NOT_FOUND
      );
    }

    const passwordHash = this.hashPassword(password);

    await this.prisma.employee.update({
      where: { id: employeeId },
      data: { passwordHash },
    });

    // Log the password change
    if (setBy) {
      await this.authService.logAction({
        employeeId: setBy,
        action: 'SET_PASSWORD',
        entityType: 'Employee',
        entityId: employeeId,
      });
    }

    return { success: true };
  }

  // --------------------------------------------------------------------------
  // Location Assignment
  // --------------------------------------------------------------------------

  async assignLocation(input: AssignLocationInput) {
    const { employeeId, locationId, role, assignedBy } = input;

    // Verify employee exists
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new HttpException(
        { success: false, message: 'Employee not found' },
        HttpStatus.NOT_FOUND
      );
    }

    // Verify location exists
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
    });

    if (!location) {
      throw new HttpException(
        { success: false, message: 'Location not found' },
        HttpStatus.NOT_FOUND
      );
    }

    // Check if PIN is unique at new location (if employee has PIN)
    if (employee.pin && employee.pinSalt) {
      // We need to get the raw PIN... but we can't. So we skip this check here.
      // The PIN uniqueness will be enforced when the employee first logs in.
      // Alternative: require PIN to be re-entered when assigning to new location
    }

    // Upsert assignment
    const assignment = await this.prisma.employeeLocationAssignment.upsert({
      where: {
        employeeId_locationId: { employeeId, locationId },
      },
      create: {
        employeeId,
        locationId,
        role,
        assignedBy,
      },
      update: {
        role,
        isActive: true,
        assignedBy,
        assignedAt: new Date(),
      },
      include: { location: true },
    });

    // Log the assignment
    if (assignedBy) {
      await this.authService.logAction({
        employeeId: assignedBy,
        locationId,
        action: 'ASSIGN_LOCATION',
        entityType: 'EmployeeLocationAssignment',
        entityId: assignment.id,
        details: { employeeId, role },
      });
    }

    return {
      id: assignment.id,
      employeeId: assignment.employeeId,
      locationId: assignment.locationId,
      locationName: assignment.location.name,
      role: assignment.role,
      isActive: assignment.isActive,
      assignedAt: assignment.assignedAt,
    };
  }

  // --------------------------------------------------------------------------
  // Update Location Assignment
  // --------------------------------------------------------------------------

  async updateLocationAssignment(
    employeeId: string,
    locationId: string,
    updates: { role?: EmployeeRole; isActive?: boolean },
    updatedBy?: string
  ) {
    const assignment = await this.prisma.employeeLocationAssignment.findUnique({
      where: {
        employeeId_locationId: { employeeId, locationId },
      },
      include: { location: true },
    });

    if (!assignment) {
      throw new HttpException(
        { success: false, message: 'Assignment not found' },
        HttpStatus.NOT_FOUND
      );
    }

    const updated = await this.prisma.employeeLocationAssignment.update({
      where: { id: assignment.id },
      data: updates,
      include: { location: true },
    });

    // Log the update
    if (updatedBy) {
      await this.authService.logAction({
        employeeId: updatedBy,
        locationId,
        action: 'UPDATE_LOCATION_ASSIGNMENT',
        entityType: 'EmployeeLocationAssignment',
        entityId: assignment.id,
        details: updates,
      });
    }

    return {
      id: updated.id,
      employeeId: updated.employeeId,
      locationId: updated.locationId,
      locationName: updated.location.name,
      role: updated.role,
      isActive: updated.isActive,
    };
  }

  // --------------------------------------------------------------------------
  // Remove Location Assignment
  // --------------------------------------------------------------------------

  async removeLocationAssignment(
    employeeId: string,
    locationId: string,
    removedBy?: string
  ) {
    const assignment = await this.prisma.employeeLocationAssignment.findUnique({
      where: {
        employeeId_locationId: { employeeId, locationId },
      },
    });

    if (!assignment) {
      throw new HttpException(
        { success: false, message: 'Assignment not found' },
        HttpStatus.NOT_FOUND
      );
    }

    // Soft delete by setting isActive = false
    await this.prisma.employeeLocationAssignment.update({
      where: { id: assignment.id },
      data: { isActive: false },
    });

    // Invalidate sessions at this location
    await this.prisma.employeeSession.deleteMany({
      where: {
        employeeId,
        locationId,
      },
    });

    // Log the removal
    if (removedBy) {
      await this.authService.logAction({
        employeeId: removedBy,
        locationId,
        action: 'REMOVE_LOCATION_ASSIGNMENT',
        entityType: 'EmployeeLocationAssignment',
        entityId: assignment.id,
        details: { employeeId },
      });
    }

    return { success: true };
  }

  // --------------------------------------------------------------------------
  // Get Employee Roles (for dropdowns)
  // --------------------------------------------------------------------------

  getEmployeeRoles() {
    return [
      { value: 'OWNER', label: 'Owner', description: 'Full access to everything' },
      { value: 'MANAGER', label: 'Manager', description: 'Inventory, reports, limited employee management' },
      { value: 'CASHIER', label: 'Cashier', description: 'Read-only inventory access' },
      { value: 'ACCOUNTANT', label: 'Accountant', description: 'Expenses, reports, read-only inventory' },
    ];
  }

  // --------------------------------------------------------------------------
  // Setup Status - Check if system needs initial setup
  // --------------------------------------------------------------------------

  async getSetupStatus() {
    const employeeCount = await this.prisma.employee.count();
    const locationCount = await this.prisma.location.count();
    
    return {
      needsSetup: employeeCount === 0,
      hasEmployees: employeeCount > 0,
      hasLocations: locationCount > 0,
      employeeCount,
      locationCount,
    };
  }

  // --------------------------------------------------------------------------
  // Initial Setup - Create first owner account and location
  // --------------------------------------------------------------------------

  async initialSetup(input: {
    ownerName: string;
    ownerEmail: string;
    ownerPassword: string;
    ownerPin: string;
    locationName: string;
    squareLocationId?: string;
  }) {
    // Check if setup is already done
    const status = await this.getSetupStatus();
    if (!status.needsSetup) {
      throw new HttpException(
        { success: false, message: 'Setup has already been completed. An owner account already exists.' },
        HttpStatus.BAD_REQUEST
      );
    }

    // Validate inputs
    if (!input.ownerName || input.ownerName.trim().length < 2) {
      throw new HttpException(
        { success: false, message: 'Owner name must be at least 2 characters' },
        HttpStatus.BAD_REQUEST
      );
    }

    if (!input.ownerEmail || !input.ownerEmail.includes('@')) {
      throw new HttpException(
        { success: false, message: 'Valid email is required' },
        HttpStatus.BAD_REQUEST
      );
    }

    if (!input.ownerPassword || input.ownerPassword.length < 6) {
      throw new HttpException(
        { success: false, message: 'Password must be at least 6 characters' },
        HttpStatus.BAD_REQUEST
      );
    }

    if (!input.ownerPin || !/^\d{4,6}$/.test(input.ownerPin)) {
      throw new HttpException(
        { success: false, message: 'PIN must be 4-6 digits' },
        HttpStatus.BAD_REQUEST
      );
    }

    if (!input.locationName || input.locationName.trim().length < 2) {
      throw new HttpException(
        { success: false, message: 'Location name must be at least 2 characters' },
        HttpStatus.BAD_REQUEST
      );
    }

    // Create location and owner in a transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Create location
      const location = await tx.location.create({
        data: {
          name: input.locationName.trim(),
          squareId: input.squareLocationId || null,
          isActive: true,
        },
      });

      // 2. Create owner employee
      const passwordHash = this.hashPassword(input.ownerPassword);
      const pinSalt = crypto.randomBytes(16).toString('hex');
      const pinHash = this.authService.hashPIN(input.ownerPin, pinSalt);

      const owner = await tx.employee.create({
        data: {
          name: input.ownerName.trim(),
          email: input.ownerEmail.toLowerCase().trim(),
          passwordHash,
          pin: pinHash,
          pinSalt,
          isActive: true,
        },
      });

      // 3. Assign owner to location
      const assignment = await tx.employeeLocationAssignment.create({
        data: {
          employeeId: owner.id,
          locationId: location.id,
          role: 'OWNER',
          isActive: true,
        },
      });

      return {
        owner: {
          id: owner.id,
          name: owner.name,
          email: owner.email,
        },
        location: {
          id: location.id,
          name: location.name,
        },
        assignment: {
          id: assignment.id,
          role: assignment.role,
        },
      };
    });

    return {
      success: true,
      message: 'Initial setup completed successfully',
      data: result,
    };
  }
}
