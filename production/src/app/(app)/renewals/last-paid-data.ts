"use client";
/**
 * R-2422 — the batched read behind each Renewals row's "Last paid" (rules: ./last-paid.ts).
 *
 * ONE query set for ALL listed rows, never one per row: five reads, each chunked by id
 * (fetchAllRowsIn — no over-long URL) and paged (no silent 1,000-row cut):
 *   1. quotes linked to these subscriptions (renewal_subscription_id / add_seats_subscription_id),
 *   2. the subscriptions' own quotes (quote_id / renewal_quote_id) — for their invoice_id,
 *   3. instalment invoices (subscription_billings),
 *   4. invoices raised from those quotes,
 *   5. payments on those quotes and invoices (status 'received' only — refunds are 'refunded').
 * Read on the signed-in browser session: RLS keeps every row to this company (and to customers
 * this person may see). Keyed under ["payments"] so recording a payment refreshes the rows.
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { lastPaidBySubscription, linkedDocs, type LastPaid, type LastPaidInput } from "./last-paid";

type SubRef = LastPaidInput["subs"][number];
type QuoteRow = LastPaidInput["linkedQuotes"][number];
type PaymentRow = LastPaidInput["payments"][number];

/** PostgREST `in.(…)` list — ids are uuids / document numbers, quoted so a comma or dot never splits one. */
const inList = (ids: readonly string[]) => `(${ids.map((x) => `"${x.replace(/["\\]/g, "")}"`).join(",")})`;

const PAYMENT_COLS = "id, amount, method, status, received_at, refunded_at, quote_id, invoice_id";

export function useRenewalLastPaid(subs: readonly SubRef[]) {
  const rows = [...new Map(subs.map((s) => [s.id, s])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const key = rows.map((s) => `${s.id}:${s.quote_id ?? ""}:${s.renewal_quote_id ?? ""}`);
  return useQuery({
    queryKey: ["payments", "renewal-last-paid", key],
    enabled: rows.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, LastPaid>> => {
      const supabase = createClient();
      const subIds = rows.map((s) => s.id);
      const quoteCols = "id, renewal_subscription_id, add_seats_subscription_id, invoice_id";
      const viaSub = await fetchAllRowsIn<QuoteRow, string>(subIds, (run, from, to) => supabase
        .from("quotes")
        .select(quoteCols)
        .or(`renewal_subscription_id.in.${inList(run)},add_seats_subscription_id.in.${inList(run)}`)
        .order("id", { ascending: true })
        .range(from, to), { chunkSize: 100 });   // the id list is in the URL twice
      const ownQuoteIds = rows.flatMap((s) => [s.quote_id, s.renewal_quote_id]).filter((x): x is string => !!x);
      const own = await fetchAllRowsIn<QuoteRow, string>(ownQuoteIds, (run, from, to) => supabase
        .from("quotes")
        .select(quoteCols)
        .in("id", run)
        .order("id", { ascending: true })
        .range(from, to));
      const billings = await fetchAllRowsIn<{ subscription_id: string; invoice_id: string | null }, string>(subIds, (run, from, to) => supabase
        .from("subscription_billings")
        .select("subscription_id, invoice_id")
        .in("subscription_id", run)
        .not("invoice_id", "is", null)
        .order("id", { ascending: true })
        .range(from, to));
      /* Own quotes are only there for their invoice_id; their sub links come from `rows`. */
      const linkedQuotes = [...viaSub, ...own.map((q) => ({ ...q, renewal_subscription_id: null, add_seats_subscription_id: null }))];
      const quoteIds = [...new Set([...ownQuoteIds, ...viaSub.map((q) => q.id)])];
      const invoices = await fetchAllRowsIn<{ id: string; quote_id: string | null }, string>(quoteIds, (run, from, to) => supabase
        .from("invoices")
        .select("id, quote_id")
        .in("quote_id", run)
        .order("id", { ascending: true })
        .range(from, to));
      const { invoiceSubs } = linkedDocs({ subs: rows, linkedQuotes, billings, invoices });
      const byQuote = await fetchAllRowsIn<PaymentRow, string>(quoteIds, (run, from, to) => supabase
        .from("payments")
        .select(PAYMENT_COLS)
        .in("quote_id", run)
        .eq("status", "received")
        .order("id", { ascending: true })
        .range(from, to));
      const byInvoice = await fetchAllRowsIn<PaymentRow, string>([...invoiceSubs.keys()], (run, from, to) => supabase
        .from("payments")
        .select(PAYMENT_COLS)
        .in("invoice_id", run)
        .eq("status", "received")
        .order("id", { ascending: true })
        .range(from, to));
      return lastPaidBySubscription({ subs: rows, linkedQuotes, billings, invoices, payments: [...byQuote, ...byInvoice] });
    },
  });
}
