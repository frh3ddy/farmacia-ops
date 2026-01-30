import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from '../auth.service';
import { EmployeeRole } from '@prisma/client';

// ============================================================================
// Decorators
// ============================================================================

export const ROLES_KEY = 'roles';
export const Roles = (...roles: EmployeeRole[]) => SetMetadata(ROLES_KEY, roles);

export const PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

// ============================================================================
// Device Guard - Validates device token
// ============================================================================

@Injectable()
export class DeviceGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers['authorization'];

    if (!authorization) {
      throw new HttpException(
        { success: false, message: 'Device token required in Authorization header' },
        HttpStatus.UNAUTHORIZED
      );
    }

    const deviceToken = authorization.replace('Bearer ', '');
    
    try {
      const device = await this.authService.validateDeviceToken(deviceToken);
      request.device = device;
      return true;
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Invalid or deactivated device' },
        HttpStatus.UNAUTHORIZED
      );
    }
  }
}

// ============================================================================
// Session Guard - Validates session token
// ============================================================================

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const sessionToken = request.headers['x-session-token'];

    if (!sessionToken) {
      throw new HttpException(
        { success: false, message: 'Session token required in X-Session-Token header' },
        HttpStatus.UNAUTHORIZED
      );
    }

    try {
      const { session, employee, currentLocation, accessibleLocations } =
        await this.authService.validateSession(sessionToken);
      
      // Attach to request for use in controllers
      request.session = session;
      request.employee = employee;
      request.currentLocation = currentLocation;
      request.accessibleLocations = accessibleLocations;
      
      return true;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        { success: false, message: 'Invalid or expired session' },
        HttpStatus.UNAUTHORIZED
      );
    }
  }
}

// ============================================================================
// Role Guard - Checks if user has required role
// ============================================================================

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Get required roles from decorator
    const requiredRoles = this.reflector.getAllAndOverride<EmployeeRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If no roles specified, allow access
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const currentLocation = request.currentLocation;

    if (!currentLocation) {
      throw new HttpException(
        { success: false, message: 'No location context' },
        HttpStatus.FORBIDDEN
      );
    }

    const hasRole = requiredRoles.includes(currentLocation.role);

    if (!hasRole) {
      throw new HttpException(
        {
          success: false,
          message: `Access denied. Requires one of: ${requiredRoles.join(', ')}`,
        },
        HttpStatus.FORBIDDEN
      );
    }

    return true;
  }
}

// ============================================================================
// Combined Auth Guard - Device + Session + Role in one
// ============================================================================

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    // Validate device token
    const authorization = request.headers['authorization'];
    if (authorization) {
      const deviceToken = authorization.replace('Bearer ', '');
      try {
        const device = await this.authService.validateDeviceToken(deviceToken);
        request.device = device;
      } catch (error) {
        // Device validation is optional for some endpoints
      }
    }

    // Validate session token
    const sessionToken = request.headers['x-session-token'];
    if (!sessionToken) {
      throw new HttpException(
        { success: false, message: 'Session token required' },
        HttpStatus.UNAUTHORIZED
      );
    }

    try {
      const { session, employee, currentLocation, accessibleLocations } =
        await this.authService.validateSession(sessionToken);
      
      request.session = session;
      request.employee = employee;
      request.currentLocation = currentLocation;
      request.accessibleLocations = accessibleLocations;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        { success: false, message: 'Invalid or expired session' },
        HttpStatus.UNAUTHORIZED
      );
    }

    // Check roles if specified
    const requiredRoles = this.reflector.getAllAndOverride<EmployeeRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRoles && requiredRoles.length > 0) {
      const currentLocation = request.currentLocation;
      
      if (!currentLocation || !requiredRoles.includes(currentLocation.role)) {
        throw new HttpException(
          {
            success: false,
            message: `Access denied. Requires one of: ${requiredRoles.join(', ')}`,
          },
          HttpStatus.FORBIDDEN
        );
      }
    }

    return true;
  }
}

// ============================================================================
// Location Guard - Ensures user has access to requested location
// ============================================================================

@Injectable()
export class LocationGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    
    // Get requested locationId from params, query, or body
    const requestedLocationId =
      request.params?.locationId ||
      request.query?.locationId ||
      request.body?.locationId;

    if (!requestedLocationId) {
      // No location specified, allow (controller will handle)
      return true;
    }

    const accessibleLocations = request.accessibleLocations || [];
    const currentLocation = request.currentLocation;

    // OWNER can access all locations (multi-location reports)
    if (currentLocation?.role === 'OWNER') {
      return true;
    }

    // Check if user has access to requested location
    const hasAccess = accessibleLocations.some(
      (a: any) => a.locationId === requestedLocationId && a.isActive
    );

    if (!hasAccess) {
      throw new HttpException(
        { success: false, message: 'Access denied to this location' },
        HttpStatus.FORBIDDEN
      );
    }

    return true;
  }
}
