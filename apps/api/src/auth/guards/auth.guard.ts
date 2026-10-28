import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from '../auth.service';
import { EmployeeRole } from '@prisma/client';

/** A request that passed AuthGuard: the validated session and the employee's location access. */
export type GuardedRequest = Request & Awaited<ReturnType<AuthService['validateSession']>>;
/** A request on a @Roles route: AuthGuard refused it unless the session has a current location. */
export type RoleGuardedRequest = GuardedRequest & { currentLocation: NonNullable<GuardedRequest['currentLocation']> };
type LocationAccess = Pick<GuardedRequest, 'currentLocation' | 'accessibleLocations'>;

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
    const deviceToken = bearerToken(authorization);
    if (!deviceToken) {
      throw new HttpException(
        { success: false, message: 'Device token required in Authorization header' },
        HttpStatus.UNAUTHORIZED
      );
    }

    // Throws 401 "Invalid or deactivated device"; anything else stays a 500.
    await this.authService.validateDeviceToken(deviceToken);
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

    // Validate session token
    const sessionToken = request.headers['x-session-token'];
    if (!sessionToken) {
      throw new HttpException(
        { success: false, message: 'Session token required' },
        HttpStatus.UNAUTHORIZED
      );
    }

    // A session only works from the device it was created on (both web and
    // iOS send the device token as Authorization: Bearer). Deactivating a
    // device deletes its sessions, so no separate device lookup is needed.
    // Auth failures throw 401s; anything else (e.g. the database) stays a 500.
    const { session, employee, currentLocation, accessibleLocations } =
      await this.authService.validateSession(sessionToken, {
        deviceToken: bearerToken(request.headers['authorization']),
      });

    request.session = session;
    request.employee = employee;
    request.currentLocation = currentLocation;
    request.accessibleLocations = accessibleLocations;

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
            message: `No tienes permiso para esto. Se requiere uno de estos roles: ${requiredRoles.join(', ')}`,
          },
          HttpStatus.FORBIDDEN
        );
      }
    }

    return true;
  }
}

/** The token in an `Authorization: Bearer <token>` header; undefined for anything else. */
export function bearerToken(authorization?: string): string | undefined {
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
}

// ============================================================================
// Location Guard - Ensures user has access to requested location
// ============================================================================

@Injectable()
export class LocationGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    
    // Check every locationId sent (params, query, body): a handler may read any
    // of them, so checking only the first let an allowed one cover another.
    // None sent: allow — the controller scopes it (see scopedLocationId).
    const requestedLocationIds = [request.params?.locationId, request.query?.locationId, request.body?.locationId];
    for (const locationId of requestedLocationIds) {
      if (locationId) assertLocationAccess(request, locationId);
    }
    return true;
  }
}

/** Throws 403 unless the session's employee may act on this location (OWNER: any). */
export function assertLocationAccess(request: LocationAccess, locationId: string): void {
  if (request.currentLocation?.role === 'OWNER') return;
  const hasAccess = (request.accessibleLocations || []).some(
    (a) => a.locationId === locationId && a.isActive
  );
  if (!hasAccess) {
    throw new HttpException(
      { success: false, message: 'No tienes acceso a esta sucursal' },
      HttpStatus.FORBIDDEN
    );
  }
}

/**
 * The location a list query may read. An omitted locationId means "all
 * locations" only for an OWNER; anyone else gets their current location
 * instead of every location's data — or a 403 when they have none (e.g. their
 * assignment there was deactivated), never "all".
 */
export function scopedLocationId(request: LocationAccess, locationId?: string): string | undefined {
  if (locationId || request.currentLocation?.role === 'OWNER') return locationId;
  const ownLocationId = request.currentLocation?.locationId;
  if (!ownLocationId) {
    throw new HttpException(
      { success: false, message: 'No tienes acceso a esta sucursal' },
      HttpStatus.FORBIDDEN
    );
  }
  return ownLocationId;
}
