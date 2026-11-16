"use client";
/**
 * R-2819 — the tenant's catalogue rows for the Renewals drawer's Our cost (the renewal quote's own
 * columns, RENEWAL_CATALOG_COLUMNS; the pick + arithmetic are drawer-money.ts). Read ONLY for a role
 * that may see cost (`enabled` — mayShowRenewalCost) and only while the drawer is open; one read per
 * tenant, shared by every drawer opened after it (never one call per renewal). Keyed under ["items"]
 * so a catalogue edit refreshes it. Kept apart from drawer-data.ts: that file is the drawer's ONE
 * documents + payments read (R-2740 / R-2765).
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { RENEWAL_CATALOG_COLUMNS, type RenewalCatalogRow } from "@/lib/renewals/renewal-catalog-cost";

export function useRenewalDrawerCatalog(tenantId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["items", "renewal-drawer-catalog", tenantId ?? ""],
    enabled: enabled && !!tenantId,
    staleTime: 60_000,
    queryFn: async (): Promise<RenewalCatalogRow[]> => {
      const supabase = createClient();
      return fetchAllRows<RenewalCatalogRow>((from, to) => supabase
        .from("items")
        .select(RENEWAL_CATALOG_COLUMNS)
        .eq("tenant_id", tenantId!)
        .order("id", { ascending: true })
        .range(from, to)
        .returns<RenewalCatalogRow[]>());
    },
  });
}
