/**
 * R-2423 — the stored facts the quote stamp (quote-kind.ts) and the part cost (part-cost.ts) need
 * for payment requests: each part (subscription_billings) and its subscription. One read for the
 * quote page, the Quotes list and the invoice page. RLS on the browser client keeps it to the
 * caller's company.
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { Item, Subscription } from "@/lib/supabase/database.types";
import type { QuoteKindQuote, QuotePartFacts } from "./quote-kind";
import { partVendorCost, type PartPeriod } from "./part-cost";

export type PartSub = Pick<Subscription,
  "id" | "plan" | "domain" | "seats" | "renewal_date" | "start_date" | "quote_id" | "billing_cycle"
  | "term_months" | "mrr" | "item_id" | "vendor_cost_per_seat_month" | "vendor_synced_at">;

export interface PartBilling extends PartPeriod { id: string; subscription_id: string }

export interface PartFactsEntry {
  billing: PartBilling;
  sub: PartSub | null;
  facts: QuotePartFacts | null;
  /** ₹ the part costs us (part-cost.ts), null = unknown. */
  cost: number | null;
}

const SUB_COLS = "id, plan, domain, seats, renewal_date, start_date, quote_id, billing_cycle, term_months, mrr, item_id, vendor_cost_per_seat_month, vendor_synced_at";

/** Pure — tested. firstTermBySub = the subscription's earliest laid term_start. */
export function partFactsOf(billing: PartBilling, sub: PartSub | null, firstTermStart: string | null): QuotePartFacts | null {
  if (!sub) return null;
  return {
    periodIndex: billing.period_index,
    periodStart: billing.period_start,
    periodEnd: billing.period_end,
    termStart: billing.term_start,
    subStartDate: sub.start_date ?? null,
    firstTermStart,
    subQuoteId: sub.quote_id ?? null,
    billingCycle: sub.billing_cycle ?? null,
    termMonths: sub.term_months ?? null,
  };
}

/** The parts behind these billing ids, keyed by billing id. Empty input → no read. */
export function usePartFacts(billingIds: readonly (string | null | undefined)[]) {
  const ids = [...new Set(billingIds.filter((x): x is string => !!x))].sort();
  return useQuery({
    queryKey: ["quote-part-facts", ids],
    enabled: ids.length > 0,
    placeholderData: (prev: Map<string, PartFactsEntry> | undefined) => prev,
    queryFn: async (): Promise<Map<string, PartFactsEntry>> => {
      const supabase = createClient();
      const { data: bills, error } = await supabase
        .from("subscription_billings")
        .select("id, subscription_id, period_index, period_start, period_end, term_start")
        .in("id", ids);
      if (error) throw error;
      const subIds = [...new Set((bills ?? []).map((b) => b.subscription_id))];
      const subs = new Map<string, PartSub>();
      if (subIds.length > 0) {
        const { data: subRows, error: e2 } = await supabase.from("subscriptions").select(SUB_COLS).in("id", subIds);
        if (e2) throw e2;
        for (const s of (subRows ?? []) as PartSub[]) subs.set(s.id, s);
      }
      /* Only a subscription with no start_date needs its first laid term (period 1 of each term). */
      const firstTerm = new Map<string, string>();
      const noStart = subIds.filter((id) => !subs.get(id)?.start_date);
      if (noStart.length > 0) {
        const { data: firsts, error: e3 } = await supabase
          .from("subscription_billings")
          .select("subscription_id, term_start")
          .in("subscription_id", noStart)
          .eq("period_index", 1);
        if (e3) throw e3;
        for (const f of firsts ?? []) {
          const cur = firstTerm.get(f.subscription_id);
          if (!cur || f.term_start < cur) firstTerm.set(f.subscription_id, f.term_start);
        }
      }
      /* The catalogue rows only for subscriptions with no vendor cost (cogs.ts falls back to them). */
      const itemIds = [...new Set([...subs.values()]
        .filter((x) => x.vendor_cost_per_seat_month == null && x.item_id)
        .map((x) => x.item_id as string))];
      let items: Item[] = [];
      if (itemIds.length > 0) {
        const { data: itemRows, error: e4 } = await supabase.from("items").select("*").in("id", itemIds);
        if (e4) throw e4;
        items = (itemRows ?? []) as Item[];
      }
      const out = new Map<string, PartFactsEntry>();
      for (const b of (bills ?? []) as PartBilling[]) {
        const sub = subs.get(b.subscription_id) ?? null;
        out.set(b.id, {
          billing: b, sub,
          facts: partFactsOf(b, sub, firstTerm.get(b.subscription_id) ?? null),
          cost: partVendorCost(sub, b, items),
        });
      }
      return out;
    },
  });
}

export interface InvoiceKindSource {
  /** The quote behind the invoice (its flags), or a part stand-in { subscription_billing_id }. */
  quote: QuoteKindQuote | null;
  /** The quote a link can open (the sale / request quote), when there is one. */
  quoteId: string | null;
}

/**
 * R-2423 (5): what an invoice was FOR — a part's invoice (subscription_billings.invoice_id, R-2101:
 * never invoices.quote_id) is that part; otherwise the quote it was raised from. Payment state is
 * left out on purpose: the invoice page shows its own.
 */
export function useInvoiceKindSource(invoiceId: string | null | undefined, invoiceQuoteId: string | null | undefined) {
  return useQuery({
    queryKey: ["invoice-kind-source", invoiceId ?? null, invoiceQuoteId ?? null],
    enabled: !!invoiceId,
    queryFn: async (): Promise<InvoiceKindSource> => {
      const supabase = createClient();
      const { data: parts, error } = await supabase
        .from("subscription_billings")
        .select("id, period_start")
        .eq("invoice_id", invoiceId!)
        .order("period_start", { ascending: true })
        .limit(1);
      if (error) throw error;
      const part = parts?.[0];
      if (part) {
        /* The request quote of that part, if one was made (else the invoice came from the pool). */
        const loose = supabase as unknown as { from: (t: string) => { select: (c: string) => { eq: (c: string, v: string) => { limit: (n: number) => Promise<{ data: { id: string }[] | null; error: unknown }> } } } };
        const { data: reqs, error: eReq } = await loose.from("quotes").select("id").eq("subscription_billing_id", part.id).limit(1);
        if (eReq) throw eReq;
        /* No request of its own → the sale quote paid it (R-2048): link that one. */
        let quoteId = reqs?.[0]?.id ?? null;
        if (!quoteId) {
          const { data: sale, error: eSale } = await supabase
            .from("subscription_billings").select("subscriptions(quote_id)").eq("id", part.id).maybeSingle();
          if (eSale) throw eSale;
          quoteId = (sale as { subscriptions?: { quote_id?: string | null } | null } | null)?.subscriptions?.quote_id ?? null;
        }
        return { quote: { subscription_billing_id: part.id }, quoteId };
      }
      if (!invoiceQuoteId) return { quote: null, quoteId: null };
      const { data: q, error: e2 } = await supabase
        .from("quotes")
        .select("id, is_renewal, is_add_seats, is_extension, extension_months, is_one_off, renewal_subscription_id, line_items")
        .eq("id", invoiceQuoteId)
        .maybeSingle();
      if (e2) throw e2;
      return { quote: q ? (q as QuoteKindQuote) : null, quoteId: q?.id ?? null };
    },
  });
}
