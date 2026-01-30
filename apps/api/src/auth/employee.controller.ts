import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Headers,
  Query,
  Param,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { EmployeeService } from './employee.service';
import { AuthService } from './auth.service';
import { EmployeeRole } from '@prisma/client';

// ============================================================================
// DTOs
// ============================================================================

interface CreateEmployeeDto {
  name: string;
  email?: string;
  password?: string;
  pin?: string;
  locationId: string;
  role: EmployeeRole;
}

interface UpdateEmployeeDto {
  name?: string;
  email?: string;
  isActive?: boolean;
}

interface SetPINDto {
  pin: string;
}

interface SetPasswordDto {
  password: string;
}

interface AssignLocationDto {
  locationId: string;
  role: EmployeeRole;
}

interface UpdateAssignmentDto {
  role?: EmployeeRole;
  isActive?: boolean;
}

// Helper functions
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getErrorStatus(error: unknown): number {
  if (error && typeof error === 'object' && 'status' in error) {
    return (error as { status: number }).status;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

// Role hierarchy for permission checks
const ROLE_HIERARCHY: Record<EmployeeRole, number> = {
  OWNER: 4,
  MANAGER: 3,
  ACCOUNTANT: 2,
  CASHIER: 1,
};

// ============================================================================
// Controller
// ============================================================================

@Controller('employees')
export class EmployeeController {
  constructor(
    private readonly employeeService: EmployeeService,
    private readonly authService: AuthService
  ) {}

  // --------------------------------------------------------------------------
  // Helper: Validate Session and Check Role
  // --------------------------------------------------------------------------
  private async validateSessionAndRole(
    sessionToken: string,
    requiredRoles: EmployeeRole[]
  ) {
    if (!sessionToken) {
      throw new HttpException(
        { success: false, message: 'Session token required' },
        HttpStatus.UNAUTHORIZED
      );
    }

    const { employee, currentLocation } = await this.authService.validateSession(sessionToken);

    if (!currentLocation) {
      throw new HttpException(
        { success: false, message: 'No location context' },
        HttpStatus.FORBIDDEN
      );
    }

    if (!requiredRoles.includes(currentLocation.role)) {
      throw new HttpException(
        { success: false, message: `Requires one of: ${requiredRoles.join(', ')}` },
        HttpStatus.FORBIDDEN
      );
    }

    return { employee, currentLocation };
  }

  // --------------------------------------------------------------------------
  // Create Employee
  // --------------------------------------------------------------------------
  @Post()
  async createEmployee(
    @Body() body: CreateEmployeeDto,
    @Headers('x-session-token') sessionToken: string
  ) {
    try {
      const { employee: currentEmployee, currentLocation } = 
        await this.validateSessionAndRole(sessionToken, ['OWNER']);

      // Validate required fields
      if (!body.name || !body.locationId || !body.role) {
        throw new HttpException(
          { success: false, message: 'Missing required fields: name, locationId, role' },
          HttpStatus.BAD_REQUEST
        );
      }

      // Validate role
      const validRoles = Object.values(EmployeeRole);
      if (!validRoles.includes(body.role)) {
        throw new HttpException(
          { success: false, message: `Invalid role. Must be one of: ${validRoles.join(', ')}` },
          HttpStatus.BAD_REQUEST
        );
      }

      // Only OWNER can create other OWNERs
      if (body.role === 'OWNER' && currentLocation.role !== 'OWNER') {
        throw new HttpException(
          { success: false, message: 'Only owners can create other owners' },
          HttpStatus.FORBIDDEN
        );
      }

      const result = await this.employeeService.createEmployee({
        name: body.name,
        email: body.email,
        password: body.password,
        pin: body.pin,
        locationId: body.locationId,
        role: body.role,
        createdBy: currentEmployee.id,
      });

      return {
        success: true,
        message: `Employee "${body.name}" created successfully`,
        data: result,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Get Employee
  // --------------------------------------------------------------------------
  @Get(':id')
  async getEmployee(
    @Param('id') employeeId: string,
    @Headers('x-session-token') sessionToken: string
  ) {
    try {
      await this.validateSessionAndRole(sessionToken, ['OWNER', 'MANAGER']);

      const employee = await this.employeeService.getEmployee(employeeId);

      return {
        success: true,
        data: employee,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // List Employees
  // --------------------------------------------------------------------------
  @Get()
  async listEmployees(
    @Headers('x-session-token') sessionToken: string,
    @Query('locationId') locationId?: string,
    @Query('role') role?: EmployeeRole,
    @Query('isActive') isActive?: string,
    @Query('limit') limit?: string
  ) {
    try {
      const { currentLocation } = await this.validateSessionAndRole(
        sessionToken,
        ['OWNER', 'MANAGER']
      );

      // If not OWNER, restrict to current location
      const targetLocationId = 
        currentLocation.role === 'OWNER' ? locationId : currentLocation.locationId;

      const employees = await this.employeeService.listEmployees({
        locationId: targetLocationId,
        role,
        isActive: isActive !== undefined ? isActive === 'true' : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
      });

      return {
        success: true,
        count: employees.length,
        data: employees,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Update Employee
  // --------------------------------------------------------------------------
  @Put(':id')
  async updateEmployee(
    @Param('id') employeeId: string,
    @Body() body: UpdateEmployeeDto,
    @Headers('x-session-token') sessionToken: string
  ) {
    try {
      const { employee: currentEmployee } = await this.validateSessionAndRole(
        sessionToken,
        ['OWNER']
      );

      const result = await this.employeeService.updateEmployee(
        employeeId,
        body,
        currentEmployee.id
      );

      return {
        success: true,
        message: 'Employee updated',
        data: result,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Deactivate Employee
  // --------------------------------------------------------------------------
  @Delete(':id')
  async deactivateEmployee(
    @Param('id') employeeId: string,
    @Headers('x-session-token') sessionToken: string
  ) {
    try {
      const { employee: currentEmployee } = await this.validateSessionAndRole(
        sessionToken,
        ['OWNER']
      );

      // Prevent self-deactivation
      if (employeeId === currentEmployee.id) {
        throw new HttpException(
          { success: false, message: 'Cannot deactivate yourself' },
          HttpStatus.BAD_REQUEST
        );
      }

      await this.employeeService.deactivateEmployee(employeeId, currentEmployee.id);

      return {
        success: true,
        message: 'Employee deactivated',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Set PIN
  // --------------------------------------------------------------------------
  @Post(':id/pin')
  async setPIN(
    @Param('id') employeeId: string,
    @Body() body: SetPINDto,
    @Headers('x-session-token') sessionToken: string
  ) {
    try {
      const { employee: currentEmployee, currentLocation } = 
        await this.validateSessionAndRole(sessionToken, ['OWNER', 'MANAGER']);

      // Validate PIN format
      if (!body.pin || !/^\d{4,6}$/.test(body.pin)) {
        throw new HttpException(
          { success: false, message: 'PIN must be 4-6 digits' },
          HttpStatus.BAD_REQUEST
        );
      }

      // Employees can set their own PIN, or OWNER/MANAGER can set for others
      if (employeeId !== currentEmployee.id) {
        // Check if current user has permission to manage target employee
        const targetEmployee = await this.employeeService.getEmployee(employeeId);
        const targetAssignment = targetEmployee.assignments.find(
          a => a.locationId === currentLocation.locationId && a.isActive
        );

        if (!targetAssignment) {
          throw new HttpException(
            { success: false, message: 'Employee not found at this location' },
            HttpStatus.NOT_FOUND
          );
        }

        // Can't set PIN for equal or higher role (unless OWNER)
        if (
          currentLocation.role !== 'OWNER' &&
          ROLE_HIERARCHY[targetAssignment.role as EmployeeRole] >= ROLE_HIERARCHY[currentLocation.role]
        ) {
          throw new HttpException(
            { success: false, message: 'Cannot manage employees of equal or higher role' },
            HttpStatus.FORBIDDEN
          );
        }
      }

      await this.employeeService.setPIN(
        { employeeId, pin: body.pin },
        currentEmployee.id
      );

      return {
        success: true,
        message: 'PIN set successfully',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Reset PIN Lockout
  // --------------------------------------------------------------------------
  @Post(':id/pin/reset-lockout')
  async resetPINLockout(
    @Param('id') employeeId: string,
    @Headers('x-session-token') sessionToken: string
  ) {
    try {
      const { employee: currentEmployee } = await this.validateSessionAndRole(
        sessionToken,
        ['OWNER', 'MANAGER']
      );

      await this.employeeService.resetPINLockout(employeeId, currentEmployee.id);

      return {
        success: true,
        message: 'PIN lockout reset',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Set Password (for device activation capability)
  // --------------------------------------------------------------------------
  @Post(':id/password')
  async setPassword(
    @Param('id') employeeId: string,
    @Body() body: SetPasswordDto,
    @Headers('x-session-token') sessionToken: string
  ) {
    try {
      const { employee: currentEmployee } = await this.validateSessionAndRole(
        sessionToken,
        ['OWNER']
      );

      if (!body.password || body.password.length < 8) {
        throw new HttpException(
          { success: false, message: 'Password must be at least 8 characters' },
          HttpStatus.BAD_REQUEST
        );
      }

      await this.employeeService.setPassword(
        employeeId,
        body.password,
        currentEmployee.id
      );

      return {
        success: true,
        message: 'Password set successfully',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Assign to Location
  // --------------------------------------------------------------------------
  @Post(':id/locations')
  async assignLocation(
    @Param('id') employeeId: string,
    @Body() body: AssignLocationDto,
    @Headers('x-session-token') sessionToken: string
  ) {
    try {
      const { employee: currentEmployee } = await this.validateSessionAndRole(
        sessionToken,
        ['OWNER']
      );

      if (!body.locationId || !body.role) {
        throw new HttpException(
          { success: false, message: 'Missing required fields: locationId, role' },
          HttpStatus.BAD_REQUEST
        );
      }

      const result = await this.employeeService.assignLocation({
        employeeId,
        locationId: body.locationId,
        role: body.role,
        assignedBy: currentEmployee.id,
      });

      return {
        success: true,
        message: `Assigned to ${result.locationName} as ${result.role}`,
        data: result,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Update Location Assignment
  // --------------------------------------------------------------------------
  @Put(':id/locations/:locationId')
  async updateLocationAssignment(
    @Param('id') employeeId: string,
    @Param('locationId') locationId: string,
    @Body() body: UpdateAssignmentDto,
    @Headers('x-session-token') sessionToken: string
  ) {
    try {
      const { employee: currentEmployee } = await this.validateSessionAndRole(
        sessionToken,
        ['OWNER']
      );

      const result = await this.employeeService.updateLocationAssignment(
        employeeId,
        locationId,
        body,
        currentEmployee.id
      );

      return {
        success: true,
        message: 'Assignment updated',
        data: result,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Remove Location Assignment
  // --------------------------------------------------------------------------
  @Delete(':id/locations/:locationId')
  async removeLocationAssignment(
    @Param('id') employeeId: string,
    @Param('locationId') locationId: string,
    @Headers('x-session-token') sessionToken: string
  ) {
    try {
      const { employee: currentEmployee } = await this.validateSessionAndRole(
        sessionToken,
        ['OWNER']
      );

      await this.employeeService.removeLocationAssignment(
        employeeId,
        locationId,
        currentEmployee.id
      );

      return {
        success: true,
        message: 'Location assignment removed',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Get Employee Roles (for dropdowns)
  // --------------------------------------------------------------------------
  @Get('roles/list')
  async getEmployeeRoles() {
    return {
      success: true,
      data: this.employeeService.getEmployeeRoles(),
    };
  }
}
