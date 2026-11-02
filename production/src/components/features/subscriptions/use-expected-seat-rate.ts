"use client";

/**
 * R-2292 — read the invoices the Manage seats preview compares its rate with: those of the
 * subscription's own sale / renewal quotes, plus the customer's recent invoices (used only when
 * the own ones have no line for the item, and only for the same domain). The rule itself is
 * lib/subscriptions/seat-rate-check.ts expectedSeatRate. RLS keeps it to this tenant.
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { Subscription } from "@/lib/supabase/database.types";
import { expectedSeatRate, type ExpectedSeatRate, type RateInvoice } from "@/lib/subscriptions/seat-rate-check";

const COLS = "id, invoice_date, status, document_kind, quote_id, line_items";
/** The customer's newest invoices looked at — enough to reach the last one for any item. */
const CUSTOMER_INVOICE_LIMIT = 50;

export function useExpectedSeatRate(sub: Subscription, enabled: boolean) {
  return useQuery({
    queryKey: ["subscriptions", "expected-seat-rate", sub.id, sub.quote_id, sub.renewal_quote_id, sub.customer_id, sub.item_id, sub.plan],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<ExpectedSeatRate | null> => {
      const supabase = createClient();
      const rows = new Map<string, RateInvoice>();
      const quoteIds = [sub.quote_id, sub.renewal_quote_id].filter((x): x is string => !!x);
      if (quoteIds.length > 0) {
        const { data, error } = await supabase.from("invoices").select(COLS).in("quote_id", quoteIds);
        if (error) throw new Error(error.message);
        for (const r of (data ?? []) as RateInvoice[]) rows.set(r.id, r);
      }
      if (sub.customer_id) {
        const { data, error } = await supabase.from("invoices").select(COLS)
          .eq("customer_id", sub.customer_id)
          .order("invoice_date", { ascending: false })
          .limit(CUSTOMER_INVOICE_LIMIT);
        if (error) throw new Error(error.message);
        for (const r of (data ?? []) as RateInvoice[]) rows.set(r.id, r);
      }
      return expectedSeatRate(
        { plan: sub.plan, item_id: sub.item_id, domain: sub.domain, quote_id: sub.quote_id, renewal_quote_id: sub.renewal_quote_id },
        Array.from(rows.values()),
      );
    },
  });
}
