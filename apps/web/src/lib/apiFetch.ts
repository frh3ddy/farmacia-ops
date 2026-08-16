export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/**
 * Same-origin fetch wrapper carrying the device/session auth headers the API
 * expects (see apps/api/src/auth). Auth headers read straight from
 * localStorage so this works before AuthContext exists (Phase 1) and after.
 *
 * Deliberately does NOT unwrap a `{ success, data }` envelope — endpoints
 * don't agree on one shape (some nest under `data`, some under `result`,
 * some return fields flat), confirmed by reading CatalogSync/WebhookTest/
 * Locations. Callers type the response as what that specific endpoint
 * actually returns, same as the legacy `.jsx` tools did.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const deviceToken = localStorage.getItem("deviceToken");
  const sessionToken = localStorage.getItem("sessionToken");

  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (deviceToken) headers.set("Authorization", `Bearer ${deviceToken}`);
  if (sessionToken) headers.set("X-Session-Token", sessionToken);

  const response = await fetch(path, { ...init, headers });
  const body = await response.json().catch(() => null);

  if (!response.ok || body?.success === false) {
    const message = body?.message ?? `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }

  return body as T;
}
