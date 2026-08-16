import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../apiFetch";
import type { Supplier } from "./types";

/** Shared by the Management, Products, and Cost History supplier panels —
 * all three fetch the same active-supplier list for their picker. */
export function useSuppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    return apiFetch<{ data: Supplier[] }>("/admin/inventory/cutover/suppliers")
      .then(body => setSuppliers(body.data))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { suppliers, loading, error, refetch };
}
