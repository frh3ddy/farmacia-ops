export type Role = "OWNER" | "MANAGER" | "CASHIER" | "ACCOUNTANT";

export type LocationAccess = {
  locationId: string;
  locationName: string;
  role: Role;
};

export type Employee = {
  id: string;
  name: string;
  email?: string;
};

export type AuthUser = {
  employee: Employee;
  currentLocation: LocationAccess | null;
  accessibleLocations: LocationAccess[];
};

export type MeResult = {
  employee: Employee;
  session: { expiresAt: string; lastActivityAt: string };
  currentLocation: LocationAccess | null;
  accessibleLocations: LocationAccess[];
};

export type SetupLocation = {
  id: string;
  name: string;
  squareId: string | null;
  isActive: boolean;
};

export type DeviceActivateResult = {
  deviceToken: string;
  device: { id: string; name: string; type: string; activatedAt: string };
  location: { id: string; name: string };
};

export type PinLoginResult = {
  sessionToken: string;
  expiresAt: string;
  employee: Employee;
  accessibleLocations: LocationAccess[];
  currentLocation: LocationAccess | null;
};

export type SetupStatus = {
  needsSetup: boolean;
  hasEmployees: boolean;
  hasLocations: boolean;
  employeeCount: number;
  locationCount: number;
  locations: SetupLocation[];
};

/** OWNER/MANAGER-gated actions in the API (device activation, cutover
 * endpoints under /admin/inventory/cutover) — use this instead of
 * re-deriving the role check per screen. */
export function isOwnerOrManager(user: AuthUser | null): boolean {
  const role = user?.currentLocation?.role;
  return role === "OWNER" || role === "MANAGER";
}

/** OWNER-only actions (catalog cleanup, location sync from Square) — a
 * strictly narrower check than isOwnerOrManager, matching the API's own
 * @Roles('OWNER') guards exactly. */
export function isOwner(user: AuthUser | null): boolean {
  return user?.currentLocation?.role === "OWNER";
}
