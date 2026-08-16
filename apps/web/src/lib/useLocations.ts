import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./apiFetch";
import type { Location } from "./types";

/**
 * One implementation of "fetch the location list", reused by every screen
 * that needs a location picker instead of each tool re-fetching /locations
 * and (in the legacy tools) sometimes hardcoding a location id as a default.
 */
export function useLocations() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    return apiFetch<{ success: true; data: Location[] }>("/locations")
      .then(body => setLocations(body.data))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { locations, loading, error, refetch };
}
