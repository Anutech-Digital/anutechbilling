"use client";
/**
 * R-2835 — the subscription's scheduled seat cuts for the Renewals drawer's Our cost. The renewal quote
 * reads them with loadScheduledSeatCuts (lib/renewals/scheduled-seat-cut.ts) — this is that same read,
 * not a second copy. Only while the drawer is open and only for a role that may see cost (`enabled`).
 * Kept apart from drawer-cost-data.ts (the catalogue read — one query per tenant, R-2819).
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { loadScheduledSeatCuts, type ScheduledSeatCutRow } from "@/lib/renewals/scheduled-seat-cut";

/** data: rows; null = the read failed (loadScheduledSeatCuts says so); undefined = still reading. */
export function useRenewalDrawerSeatCuts(tenantId: string | null, subscriptionId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["subscriptions", "renewal-drawer-seat-cuts", tenantId ?? "", subscriptionId ?? ""],
    enabled: enabled && !!tenantId && !!subscriptionId,
    staleTime: 30_000,
    queryFn: async (): Promise<ScheduledSeatCutRow[] | null> =>
      loadScheduledSeatCuts(createClient(), tenantId!, subscriptionId!),
  });
}
