import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Query,
  Param,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { EmployeeService } from './employee.service';
import { LocationsService } from '../locations/locations.service';
import { DeviceType } from '@prisma/client';

// ============================================================================
// DTOs
// ============================================================================

interface ActivateDeviceDto {
  email: string;
  password: string;
  deviceName: string;
  locationId?: string;  // Optional - auto-selects first location if not provided
  deviceType?: DeviceType;
}

interface PINLoginDto {
  pin: string;
}

interface SwitchLocationDto {
  locationId: string;
}

// ============================================================================
// Controller
// ============================================================================

// Setup DTO
interface InitialSetupDto {
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
  ownerPin: string;
  locationId?: string;        // Use existing location
  locationName?: string;      // Create new location
  squareLocationId?: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly employeeService: EmployeeService,
    private readonly locationsService: LocationsService,
  ) {}

  // --------------------------------------------------------------------------
  // Setup Status - Check if initial setup is needed (PUBLIC)
  // --------------------------------------------------------------------------
  @Get('setup/status')
  async getSetupStatus() {
    const status = await this.employeeService.getSetupStatus();
    return {
      success: true,
      data: status,
    };
  }

  // --------------------------------------------------------------------------
  // Fetch Square Locations - For setup screen (PUBLIC, only works if no employees exist)
  // --------------------------------------------------------------------------
  @Get('setup/square-locations')
  async getSquareLocations() {
    // Only allow this if setup is needed (no employees exist)
    const status = await this.employeeService.getSetupStatus();
    if (!status.needsSetup) {
      throw new HttpException(
        { success: false, message: 'Setup already completed. Use authenticated endpoints.' },
        HttpStatus.FORBIDDEN
      );
    }

    const result = await this.locationsService.fetchSquareLocations();
    return {
      success: true,
      data: result.locations,
      count: result.locations.length,
    };
  }

  // --------------------------------------------------------------------------
  // Sync Square Locations and Create in DB - For setup screen (PUBLIC, only works if no employees exist)
  // --------------------------------------------------------------------------
  @Post('setup/sync-locations')
  async syncSquareLocationsForSetup() {
    // Only allow this if setup is needed (no employees exist)
    const status = await this.employeeService.getSetupStatus();
    if (!status.needsSetup) {
      throw new HttpException(
        { success: false, message: 'Setup already completed. Use authenticated endpoints.' },
        HttpStatus.FORBIDDEN
      );
    }

    const result = await this.locationsService.syncLocationsFromSquare();
    
    // Fetch the newly synced locations
    const updatedStatus = await this.employeeService.getSetupStatus();
    
    return {
      success: true,
      message: `Synced ${result.total} locations: ${result.created} created, ${result.updated} updated`,
      data: {
        ...result,
        locations: updatedStatus.locations,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Initial Setup - Create first owner account (PUBLIC, only works if no employees exist)
  // --------------------------------------------------------------------------
  @Post('setup/initial')
  async initialSetup(@Body() body: InitialSetupDto) {
    const result = await this.employeeService.initialSetup({
      ownerName: body.ownerName,
      ownerEmail: body.ownerEmail,
      ownerPassword: body.ownerPassword,
      ownerPin: body.ownerPin,
      locationId: body.locationId,
      locationName: body.locationName,
      squareLocationId: body.squareLocationId,
    });
    return result;
  }

  // --------------------------------------------------------------------------
  // Device Activation
  // --------------------------------------------------------------------------
  @Post('device/activate')
  async activateDevice(@Body() body: ActivateDeviceDto) {
    // Validate required fields
    if (!body.email || !body.password || !body.deviceName) {
      throw new HttpException(
        { success: false, message: 'Missing required fields: email, password, deviceName' },
        HttpStatus.BAD_REQUEST
      );
    }

    const result = await this.authService.activateDevice({
      email: body.email,
      password: body.password,
      deviceName: body.deviceName,
      locationId: body.locationId,  // Optional - service will auto-select
      deviceType: body.deviceType,
    });

    return {
      success: true,
      message: `Device "${body.deviceName}" activated successfully`,
      data: result,
    };
  }

  // --------------------------------------------------------------------------
  // Device Deactivation
  // --------------------------------------------------------------------------
  @Post('device/:deviceId/deactivate')
  async deactivateDevice(
    @Param('deviceId') deviceId: string,
    @Headers('x-session-token') sessionToken: string
  ) {
    if (!sessionToken) {
      throw new HttpException(
        { success: false, message: 'Session token required' },
        HttpStatus.UNAUTHORIZED
      );
    }

    const { employee } = await this.authService.validateSession(sessionToken);
    await this.authService.deactivateDevice(deviceId, employee.id);

    return {
      success: true,
      message: 'Device deactivated successfully',
    };
  }

  // --------------------------------------------------------------------------
  // Get Active Devices
  // --------------------------------------------------------------------------
  @Get('devices')
  async getActiveDevices(
    @Headers('x-session-token') sessionToken: string,
    @Query('locationId') locationId?: string
  ) {
    if (!sessionToken) {
      throw new HttpException(
        { success: false, message: 'Session token required' },
        HttpStatus.UNAUTHORIZED
      );
    }

    const { employee, currentLocation } = await this.authService.validateSession(sessionToken);
    const targetLocationId = locationId || currentLocation?.locationId;
    if (!targetLocationId) {
      throw new HttpException(
        { success: false, message: 'No location context' },
        HttpStatus.BAD_REQUEST
      );
    }

    const devices = await this.authService.getActiveDevicesForOwner(employee.id, targetLocationId);

    return {
      success: true,
      count: devices.length,
      data: devices.map(d => ({
        id: d.id,
        name: d.name,
        type: d.type,
        isActive: d.isActive,
        lastActiveAt: d.lastActiveAt,
        activatedAt: d.activatedAt,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // PIN Login
  // --------------------------------------------------------------------------
  @Post('pin')
  async loginWithPIN(
    @Body() body: PINLoginDto,
    @Headers('authorization') authorization: string
  ) {
    // Validate PIN format
    if (!body.pin || !/^\d{4,6}$/.test(body.pin)) {
      throw new HttpException(
        { success: false, message: 'Invalid PIN format. Must be 4-6 digits.' },
        HttpStatus.BAD_REQUEST
      );
    }

    // Extract device token from Authorization header
    const deviceToken = authorization?.replace('Bearer ', '');
    if (!deviceToken) {
      throw new HttpException(
        { success: false, message: 'Device token required in Authorization header' },
        HttpStatus.UNAUTHORIZED
      );
    }

    const result = await this.authService.loginWithPIN({
      pin: body.pin,
      deviceToken,
    });

    return {
      success: true,
      message: `Welcome, ${result.employee.name}`,
      data: result,
    };
  }

  // --------------------------------------------------------------------------
  // Refresh Session
  // --------------------------------------------------------------------------
  @Post('pin/refresh')
  async refreshSession(@Headers('x-session-token') sessionToken: string) {
    if (!sessionToken) {
      throw new HttpException(
        { success: false, message: 'Session token required' },
        HttpStatus.UNAUTHORIZED
      );
    }

    const result = await this.authService.refreshSession(sessionToken);

    return {
      success: true,
      message: 'Session refreshed',
      data: result,
    };
  }

  // --------------------------------------------------------------------------
  // Switch Location
  // --------------------------------------------------------------------------
  @Post('switch-location')
  async switchLocation(
    @Body() body: SwitchLocationDto,
    @Headers('x-session-token') sessionToken: string
  ) {
    if (!body.locationId) {
      throw new HttpException(
        { success: false, message: 'locationId is required' },
        HttpStatus.BAD_REQUEST
      );
    }

    if (!sessionToken) {
      throw new HttpException(
        { success: false, message: 'Session token required' },
        HttpStatus.UNAUTHORIZED
      );
    }

    const result = await this.authService.switchLocation({
      locationId: body.locationId,
      sessionToken,
    });

    return {
      success: true,
      message: `Switched to ${result.currentLocation.locationName}`,
      data: result,
    };
  }

  // --------------------------------------------------------------------------
  // Get Current Session
  // --------------------------------------------------------------------------
  @Get('me')
  async getCurrentSession(@Headers('x-session-token') sessionToken: string) {
    if (!sessionToken) {
      throw new HttpException(
        { success: false, message: 'Session token required' },
        HttpStatus.UNAUTHORIZED
      );
    }

    const { session, employee, currentLocation, accessibleLocations } =
      await this.authService.validateSession(sessionToken);

    return {
      success: true,
      data: {
        employee: {
          id: employee.id,
          name: employee.name,
          email: employee.email,
        },
        session: {
          expiresAt: session.expiresAt,
          lastActivityAt: session.lastActivityAt,
        },
        currentLocation: currentLocation
          ? {
              locationId: currentLocation.locationId,
              locationName: currentLocation.location.name,
              role: currentLocation.role,
            }
          : null,
        accessibleLocations: accessibleLocations.map(a => ({
          locationId: a.locationId,
          locationName: a.location.name,
          role: a.role,
        })),
      },
    };
  }

  // --------------------------------------------------------------------------
  // Logout
  // --------------------------------------------------------------------------
  @Post('logout')
  async logout(@Headers('x-session-token') sessionToken: string) {
    try {
      if (!sessionToken) {
        // Already logged out
        return {
          success: true,
          message: 'Logged out',
        };
      }

      await this.authService.logout(sessionToken);

      return {
        success: true,
        message: 'Logged out successfully',
      };
    } catch (error) {
      // Even if logout fails, return success (user wanted to logout)
      return {
        success: true,
        message: 'Logged out',
      };
    }
  }

  // --------------------------------------------------------------------------
  // Get Audit Logs
  // --------------------------------------------------------------------------
  @Get('audit-logs')
  async getAuditLogs(
    @Headers('x-session-token') sessionToken: string,
    @Query('locationId') locationId?: string,
    @Query('employeeId') employeeId?: string,
    @Query('action') action?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string
  ) {
    if (!sessionToken) {
      throw new HttpException(
        { success: false, message: 'Session token required' },
        HttpStatus.UNAUTHORIZED
      );
    }

    // Validate session
    await this.authService.validateSession(sessionToken);

    const logs = await this.authService.getAuditLogs({
      locationId,
      employeeId,
      action,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });

    return {
      success: true,
      count: logs.length,
      data: logs,
    };
  }

  // --------------------------------------------------------------------------
  // Cleanup Expired Sessions (admin endpoint)
  // --------------------------------------------------------------------------
  @Post('sessions/cleanup')
  async cleanupExpiredSessions(@Headers('x-session-token') sessionToken: string) {
    if (!sessionToken) {
      throw new HttpException(
        { success: false, message: 'Session token required' },
        HttpStatus.UNAUTHORIZED
      );
    }

    // Validate session (should be OWNER)
    const { currentLocation } = await this.authService.validateSession(sessionToken);
    
    if (currentLocation?.role !== 'OWNER') {
      throw new HttpException(
        { success: false, message: 'Only owners can perform this action' },
        HttpStatus.FORBIDDEN
      );
    }

    const result = await this.authService.cleanupExpiredSessions();

    return {
      success: true,
      message: `Cleaned up ${result.deletedCount} expired sessions`,
      data: result,
    };
  }
}
