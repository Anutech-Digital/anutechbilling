/**
 * R-2459 — the buyers' states the Quotes list needs to ask the customer-copy gate per row
 * (customerCopyBlockForRow): the customers and leads behind the quotes whose place of supply
 * can still block a customer copy, read in chunks like useQuoteLeadContacts (a long `in.(…)`
 * URL can be refused by a proxy). Read-only; RLS scopes both tables to the tenant.
 *
 * A failed read throws, so the query is in error and the list judges no row "no state" — a
 * row is only ever disabled from a state it actually read.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { CustomerCopyParties } from "@/lib/quotes/customer-copy-gate";

const CHUNK = 100;

type CustomerPlace = NonNullable<CustomerCopyParties["customer"]>;
type LeadPlace = NonNullable<CustomerCopyParties["lead"]>;

export interface QuoteCopyParties {
  customers: Map<string, CustomerPlace>;
  leads: Map<string, LeadPlace>;
}

export function useQuoteCopyParties(customerIds: readonly string[], leadIds: readonly string[]) {
  const cIds = [...new Set(customerIds.filter(Boolean))].sort();
  const lIds = [...new Set(leadIds.filter(Boolean))].sort();
  return useQuery({
    queryKey: ["quote-copy-parties", cIds, lIds],
    staleTime: 60_000,
    queryFn: async (): Promise<QuoteCopyParties> => {
      const supabase = createClient();
      const chunks = (ids: string[]) => Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_, i) => ids.slice(i * CHUNK, (i + 1) * CHUNK));
      const [customerReads, leadReads] = await Promise.all([
        Promise.all(chunks(cIds).map((part) => supabase
          .from("customers").select("id, name, state_code, gstin, country, gst_treatment").in("id", part))),
        Promise.all(chunks(lIds).map((part) => supabase
          .from("leads").select("id, state_code, gstin, country").in("id", part))),
      ]);
      const customers = new Map<string, CustomerPlace>();
      const leads = new Map<string, LeadPlace>();
      for (const { data, error } of customerReads) {
        if (error) throw error;
        for (const { id, ...row } of data ?? []) customers.set(id, row);
      }
      for (const { data, error } of leadReads) {
        if (error) throw error;
        for (const { id, ...row } of data ?? []) leads.set(id, row);
      }
      return { customers, leads };
    },
  });
}
