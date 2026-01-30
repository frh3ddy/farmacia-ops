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
import { DeviceType } from '@prisma/client';

// ============================================================================
// DTOs
// ============================================================================

interface ActivateDeviceDto {
  email: string;
  password: string;
  deviceName: string;
  locationId: string;
  deviceType?: DeviceType;
}

interface PINLoginDto {
  pin: string;
}

interface SwitchLocationDto {
  locationId: string;
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

// ============================================================================
// Controller
// ============================================================================

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // --------------------------------------------------------------------------
  // Device Activation
  // --------------------------------------------------------------------------
  @Post('device/activate')
  async activateDevice(@Body() body: ActivateDeviceDto) {
    try {
      // Validate required fields
      if (!body.email || !body.password || !body.deviceName || !body.locationId) {
        throw new HttpException(
          { success: false, message: 'Missing required fields: email, password, deviceName, locationId' },
          HttpStatus.BAD_REQUEST
        );
      }

      const result = await this.authService.activateDevice({
        email: body.email,
        password: body.password,
        deviceName: body.deviceName,
        locationId: body.locationId,
        deviceType: body.deviceType,
      });

      return {
        success: true,
        message: `Device "${body.deviceName}" activated successfully`,
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
  // Device Deactivation
  // --------------------------------------------------------------------------
  @Post('device/:deviceId/deactivate')
  async deactivateDevice(
    @Param('deviceId') deviceId: string,
    @Headers('x-session-token') sessionToken: string
  ) {
    try {
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
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Get Active Devices
  // --------------------------------------------------------------------------
  @Get('devices')
  async getActiveDevices(
    @Headers('authorization') authorization: string,
    @Query('locationId') locationId?: string
  ) {
    try {
      // Extract device token from Authorization header
      const deviceToken = authorization?.replace('Bearer ', '');
      if (!deviceToken) {
        throw new HttpException(
          { success: false, message: 'Device token required' },
          HttpStatus.UNAUTHORIZED
        );
      }

      const device = await this.authService.validateDeviceToken(deviceToken);
      const targetLocationId = locationId || device.locationId;

      const devices = await this.authService.getActiveDevices(targetLocationId);

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
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // PIN Login
  // --------------------------------------------------------------------------
  @Post('pin')
  async loginWithPIN(
    @Body() body: PINLoginDto,
    @Headers('authorization') authorization: string
  ) {
    try {
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
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Refresh Session
  // --------------------------------------------------------------------------
  @Post('pin/refresh')
  async refreshSession(@Headers('x-session-token') sessionToken: string) {
    try {
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
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Switch Location
  // --------------------------------------------------------------------------
  @Post('switch-location')
  async switchLocation(
    @Body() body: SwitchLocationDto,
    @Headers('x-session-token') sessionToken: string
  ) {
    try {
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
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Get Current Session
  // --------------------------------------------------------------------------
  @Get('me')
  async getCurrentSession(@Headers('x-session-token') sessionToken: string) {
    try {
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
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
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
    try {
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
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Cleanup Expired Sessions (admin endpoint)
  // --------------------------------------------------------------------------
  @Post('sessions/cleanup')
  async cleanupExpiredSessions(@Headers('x-session-token') sessionToken: string) {
    try {
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
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }
}
