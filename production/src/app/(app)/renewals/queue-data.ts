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
import { displayPhone } from "@/components/features/renewals/renewal-contact-rules";
import type { RenewalQuoteInfo } from "./queue";
import type { RenewalFollowupRow } from "./followup";
import { togetherMemberPayments, type RenewalQuotePayment } from "./tiles";
import { RENEWALS_READ_CONCURRENCY } from "./last-docs-data";
import { TOGETHER_LINK_COLS } from "./together-links-data";
import { liveTogetherLinks, type TogetherLink } from "./last-docs";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface RowContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  /** R-2824: customers.country — the dialling code for a number saved without one (call / WhatsApp links). */
  country?: string | null;
}

const CHUNK = 150;

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Primary contact wins; the legacy customers.contact_* columns fill what it leaves empty.
 * R-2857: the phone is in the ONE display form ("+91 98765 98765", displayPhone) — the row, the card,
 * the drawer and the follow-up dialog all print this value, so they can never differ; its tel: /
 * WhatsApp links read the same digits back (lib/phone). Display only: nothing is written.
 */
export function mergeContact(
  primary: { name: string | null; email: string | null; phone: string | null } | undefined,
  legacy: { contact_email: string | null; contact_phone: string | null; country?: string | null } | undefined,
): RowContact {
  const country = legacy?.country?.trim() || null;
  return {
    name: primary?.name ?? null,
    email: primary?.email?.trim() || legacy?.contact_email?.trim() || null,
    phone: displayPhone(primary?.phone?.trim() || legacy?.contact_phone?.trim() || null, country),
    country,
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
      const legacy = await fetchAllRowsIn<{ id: string; contact_email: string | null; contact_phone: string | null; country: string | null }, string>(
        ids,
        (run, from, to) => supabase
          .from("customers")
          .select("id, contact_email, contact_phone, country")
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

/**
 * The linked quotes' facts (total, status, paid?) for the listed renewals — the row's Status waits for them.
 * R-2855: the id chunks are read 4 at a time (R-2765's RENEWALS_READ_CONCURRENCY). They ran one after
 * another: staging's 786 subscriptions = ~1,570 quote ids = 8 requests in a row before any Status chip
 * could show. Same rows, same order (fetchAllRowsIn returns them in chunk order).
 */
export async function readRenewalQuoteInfo(quoteIds: readonly (string | null)[]): Promise<Map<string, RenewalQuoteInfo>> {
  const ids = [...new Set(quoteIds.filter((x): x is string => !!x))].sort();
  const supabase = createClient();
  const rows = await fetchAllRowsIn<RenewalQuoteInfo, string>(
    ids,
    (run, from, to) => supabase
      .from("quotes")
      .select("id, amount, status, payment_status, currency, exchange_rate")   // R-2767: currency for foreign customers
      .in("id", run)
      .order("id", { ascending: true })
      .range(from, to),
    { concurrency: RENEWALS_READ_CONCURRENCY },
  );
  return new Map(rows.map((q) => [q.id, q]));
}

export function useRenewalQuoteInfo(quoteIds: readonly (string | null)[]) {
  const ids = [...new Set(quoteIds.filter((x): x is string => !!x))].sort();
  return useQuery({
    queryKey: ["quotes", "renewal-amounts", ids],
    enabled: ids.length > 0,
    queryFn: () => readRenewalQuoteInfo(ids),
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
      const own = await fetchAllRows<RenewalQuotePayment>((from, to) => supabase
        .from("quotes")
        /* R-2751: subtotal / discount_pct / tax_rate → the paid renewal's amount before GST (tiles.ts quoteAmountBeforeGst). */
        .select("id, amount, payment_amount, payment_status, status, renewal_subscription_id, renewal_term_date, subtotal, discount_pct, tax_rate")
        .eq("is_renewal", true)
        .gte("renewal_term_date", month.start)
        .lte("renewal_term_date", month.end)
        .order("id", { ascending: true })
        .range(from, to));
      /* R-2870: quotes billed together carry no renewal_term_date — each member's term is on its renewal_quote_subscriptions row.
         One more read (links of this month), then those quotes' paid state; togetherMemberPayments makes one entry per member. */
      const loose = supabase as unknown as SupabaseClient;
      try {
        const links = liveTogetherLinks(await fetchAllRows<TogetherLink>((from, to) => loose
          .from("renewal_quote_subscriptions")
          .select(TOGETHER_LINK_COLS)
          .gte("renewal_term_date", month.start)
          .lte("renewal_term_date", month.end)
          .order("id", { ascending: true })
          .range(from, to)));
        if (links.length === 0) return own;
        const quotes = await fetchAllRowsIn<Parameters<typeof togetherMemberPayments>[1][number], string>([...new Set(links.map((l) => l.quote_id))], (run, from, to) => loose
          .from("quotes")
          .select("id, amount, payment_amount, payment_status, status, tax_rate")
          .in("id", run)
          .order("id", { ascending: true })
          .range(from, to));
        return [...own, ...togetherMemberPayments(links, quotes, month)];
      } catch (e) {
        console.warn("R-2870: together renewals not read for the month", e);
        return own;
      }
    },
  });
}
