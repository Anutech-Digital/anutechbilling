/**
 * R-278 — the contact bits (company, name, email, phone) of the leads behind quotes, so the
 * Quotes list can show "Pardeep Sharma" instead of "Prospect" and be searched by email or
 * phone. Read-only; RLS scopes leads to the tenant like every other leads read.
 *
 * Ids are fetched in chunks: one `in.(…)` with hundreds of uuids makes a URL long enough
 * for a proxy to refuse, and a refused read here must only cost the fallback names.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { LeadContactBits } from "@/lib/quotes/quote-party-name";

const CHUNK = 100;

export function useQuoteLeadContacts(leadIds: readonly string[]) {
  const ids = [...new Set(leadIds.filter(Boolean))].sort();
  return useQuery({
    queryKey: ["quote-lead-contacts", ids],
    enabled: ids.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, LeadContactBits>> => {
      const supabase = createClient();
      const out = new Map<string, LeadContactBits>();
      for (let i = 0; i < ids.length; i += CHUNK) {
        const { data, error } = await supabase
          .from("leads")
          .select("id, company, contact_name, contact_email, contact_phone")
          .in("id", ids.slice(i, i + CHUNK));
        if (error) {
          console.warn("quote lead contacts query error:", error.message);
          continue;
        }
        for (const row of data ?? []) out.set(row.id, row);
      }
      return out;
    },
  });
}
