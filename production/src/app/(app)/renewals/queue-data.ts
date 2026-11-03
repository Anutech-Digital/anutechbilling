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
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { primaryContactsFor } from "@/lib/contacts/primary";
import type { RenewalQuoteInfo } from "./queue";
import type { RenewalFollowupRow } from "./followup";
import type { RenewalQuotePayment } from "./tiles";

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

/**
 * R-2404: the listed renewals' follow-ups (payment_followups with their subscription_id — Payment
 * Follow-up's own rows, no second table) and each customer's owner (customers.account_manager_id).
 * Read on the signed-in session: RLS keeps both to this company and to customers this person may
 * see. Keyed under ["collections"], so saving a follow-up (useAddFollowup / postFollowup callers
 * invalidating ["collections"]) refreshes the row at once.
 */
export function useRenewalFollowups(subscriptionIds: readonly string[], customerIds: readonly string[]) {
  const subs = [...new Set(subscriptionIds.filter(Boolean))].sort();
  const custs = [...new Set(customerIds.filter(Boolean))].sort();
  return useQuery({
    queryKey: ["collections", "renewal-followups", subs, custs],
    enabled: subs.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<{ rows: RenewalFollowupRow[]; ownerByCustomer: Map<string, string | null> }> => {
      const supabase = createClient();
      const rows = await fetchAllRowsIn<RenewalFollowupRow, string>(
        subs,
        (run, from, to) => supabase
          .from("payment_followups")
          .select("id, customer_id, subscription_id, kind, note, outcome, promised_amount, promised_on, next_follow_up_on, assigned_to, created_at")
          .in("subscription_id", run)
          .order("id", { ascending: true })
          .range(from, to),
      );
      const owners = custs.length === 0 ? [] : await fetchAllRowsIn<{ id: string; account_manager_id: string | null }, string>(
        custs,
        (run, from, to) => supabase
          .from("customers")
          .select("id, account_manager_id")
          .in("id", run)
          .order("id", { ascending: true })
          .range(from, to),
      );
      return { rows, ownerByCustomer: new Map(owners.map((c) => [c.id, c.account_manager_id])) };
    },
  });
}

/**
 * R-2405: this month's renewal quotes (renewal_term_date = the renewal date each one renews, in
 * this IST month) with what was paid on them — the "Renewed this month" tile (tiles.ts decides
 * which are fully paid). Read on the signed-in session: RLS keeps it to this company.
 */
export function useRenewalPaymentsForMonth(month: { start: string; end: string }) {
  return useQuery({
    queryKey: ["quotes", "renewal-payments-month", month.start, month.end],
    staleTime: 60_000,
    queryFn: async (): Promise<RenewalQuotePayment[]> => {
      const supabase = createClient();
      return fetchAllRows<RenewalQuotePayment>((from, to) => supabase
        .from("quotes")
        .select("id, amount, payment_amount, payment_status, status, renewal_subscription_id, renewal_term_date")
        .eq("is_renewal", true)
        .gte("renewal_term_date", month.start)
        .lte("renewal_term_date", month.end)
        .order("id", { ascending: true })
        .range(from, to));
    },
  });
}
