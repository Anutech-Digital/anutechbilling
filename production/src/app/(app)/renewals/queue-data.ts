"use client";
/**
 * R-2403 — what the Renewals queue needs beyond the subscription rows: each listed customer's
 * contact (phone / email on the row — audit problem 10) and each linked renewal quote's total and
 * payment status (the renewal amount, and "paid → leaves Overdue").
 *
 * Contacts: the one resolver (lib/contacts/primary primaryContactsFor — the link table), with the
 * customer's legacy contact_* columns as the floor, like primaryContactEmail. Read-only; RLS
 * scopes every read. Ids are chunked so a long list never builds an over-long URL.
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { primaryContactsFor } from "@/lib/contacts/primary";
import type { RenewalQuoteInfo } from "./queue";

export interface RowContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

const CHUNK = 150;

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Primary contact wins; the legacy customers.contact_* columns fill what it leaves empty. */
export function mergeContact(
  primary: { name: string | null; email: string | null; phone: string | null } | undefined,
  legacy: { contact_email: string | null; contact_phone: string | null } | undefined,
): RowContact {
  return {
    name: primary?.name ?? null,
    email: primary?.email?.trim() || legacy?.contact_email?.trim() || null,
    phone: primary?.phone?.trim() || legacy?.contact_phone?.trim() || null,
  };
}

export function useRenewalContacts(customerIds: readonly string[]) {
  const ids = [...new Set(customerIds.filter(Boolean))].sort();
  return useQuery({
    queryKey: ["renewals", "contacts", ids],
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Map<string, RowContact>> => {
      const supabase = createClient();
      const primary = new Map<string, { name: string | null; email: string | null; phone: string | null }>();
      for (const run of chunks(ids, CHUNK)) {
        const m = await primaryContactsFor(supabase, run);
        for (const [k, v] of m) primary.set(k, v);
      }
      const legacy = await fetchAllRowsIn<{ id: string; contact_email: string | null; contact_phone: string | null }, string>(
        ids,
        (run, from, to) => supabase
          .from("customers")
          .select("id, contact_email, contact_phone")
          .in("id", run)
          .order("id", { ascending: true })
          .range(from, to),
      );
      const legacyById = new Map(legacy.map((c) => [c.id, c]));
      const out = new Map<string, RowContact>();
      for (const id of ids) out.set(id, mergeContact(primary.get(id), legacyById.get(id)));
      return out;
    },
  });
}

export function useRenewalQuoteInfo(quoteIds: readonly (string | null)[]) {
  const ids = [...new Set(quoteIds.filter((x): x is string => !!x))].sort();
  return useQuery({
    queryKey: ["quotes", "renewal-amounts", ids],
    enabled: ids.length > 0,
    queryFn: async (): Promise<Map<string, RenewalQuoteInfo>> => {
      const supabase = createClient();
      const rows = await fetchAllRowsIn<RenewalQuoteInfo, string>(
        ids,
        (run, from, to) => supabase
          .from("quotes")
          .select("id, amount, status, payment_status")
          .in("id", run)
          .order("id", { ascending: true })
          .range(from, to),
      );
      return new Map(rows.map((q) => [q.id, q]));
    },
  });
}
