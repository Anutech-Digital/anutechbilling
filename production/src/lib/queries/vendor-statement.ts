/**
 * R-1921 — the vendor statement and the payables ageing: two reads from the database
 * (vendor_statement / payables_ageing, migration 20261026171338). Nothing here computes money.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  foldStatement, toAgeingRow, toStatementRow,
  type PayablesAgeingRow, type VendorStatement,
} from "@/lib/accounting/vendor-statement";

/* The generated types do not know the R-1921 functions yet (migration not applied there). */
type RpcClient = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> };
const rpc = (fn: string, args?: Record<string, unknown>) => (createClient() as unknown as RpcClient).rpc(fn, args);

export const vendorStatementKey = (vendorId: string | null | undefined) => ["vendor_statement", vendorId ?? null] as const;
export const payablesAgeingKey = () => ["payables_ageing"] as const;

/** A vendor's statement, oldest first, with the running balance. */
export function useVendorStatement(vendorId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: vendorStatementKey(vendorId),
    enabled: Boolean(vendorId) && enabled,
    queryFn: async (): Promise<VendorStatement> => {
      const { data, error } = await rpc("vendor_statement", { p_vendor_id: vendorId });
      if (error) throw new Error(error.message);
      return foldStatement(((data as Record<string, unknown>[] | null) ?? []).map(toStatementRow));
    },
    staleTime: 30_000,
  });
}

/** What we owe each vendor, by days past the due date. */
export function usePayablesAgeing(enabled = true) {
  return useQuery({
    queryKey: payablesAgeingKey(),
    enabled,
    queryFn: async (): Promise<PayablesAgeingRow[]> => {
      const { data, error } = await rpc("payables_ageing");
      if (error) throw new Error(error.message);
      return ((data as Record<string, unknown>[] | null) ?? []).map(toAgeingRow);
    },
    staleTime: 30_000,
  });
}
