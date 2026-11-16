"use client";
/**
 * R-1764 — the context a saved quote's lines read their "Domain:" and "Subscription period:"
 * from (lib/quotes/service-period.ts). A renewal quote stores no domain, so it is read from the
 * subscription the quote renews. Null quote → null (nothing printed).
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useCustomerSubscriptions } from "@/lib/queries/subscriptions";
import { createClient } from "@/lib/supabase/client";
import { loadInvoicePeriodRuleFrom } from "@/lib/quotes/line-period-context";
import {
  quoteLinePeriodContext, renewedSubscription, invoicePeriodSubscription, togetherLineSubscriptions, R2727_PERIOD_RULE_KEY, type LinePeriodContext,
} from "@/lib/quotes/service-period";
import type { Invoice, Quote } from "@/lib/supabase/database.types";

/** R-2727 review (MED): when the invoice period rule went live on THIS database (app_rule_dates,
 *  set by the card's migration). Read once per session; null (no row / unreadable) = the old rule. */
export function useInvoicePeriodRuleFrom(enabled: boolean): string | null {
  const { data } = useQuery({
    queryKey: ["app_rule_dates", R2727_PERIOD_RULE_KEY],
    queryFn: () => loadInvoicePeriodRuleFrom(createClient()),
    enabled,
    staleTime: Infinity,
  });
  return data ?? null;
}

/** `invoice` (an invoice view, R-2727 review): an invoice created before the period rule went live
 *  here shows its period exactly as its PDF prints it — the rule before R-2727. */
export function useQuotePeriodContext(
  quote: Quote | null | undefined,
  invoice?: Pick<Invoice, "created_at"> | null,
): LinePeriodContext | null {
  /* R-2727: also when the quote has its own domain — the renewed subscription's start + term decide
     where the next term starts (billing's followingTermStart). */
  const needsSub = !!quote && (quote.is_renewal || quote.is_extension);
  const { data: subs } = useCustomerSubscriptions(needsSub ? (quote?.customer_id ?? undefined) : undefined);
  const ruleFrom = useInvoicePeriodRuleFrom(invoice !== undefined && needsSub);
  return React.useMemo(() => {
    if (!quote) return null;
    /* R-2849: a together renewal quote — each line's own subscription (start + term, domain) from the same list */
    const lines = needsSub ? togetherLineSubscriptions(quote.line_items as Array<{ subscription_id?: unknown }> | null, subs) : null;
    const renewed = needsSub ? renewedSubscription(quote, subs) : null;
    const facts = lines ? { ...(renewed ?? {}), lines } : renewed;
    return quoteLinePeriodContext(quote, invoice !== undefined ? invoicePeriodSubscription(invoice ?? {}, ruleFrom, quote, facts) : facts);
  }, [quote, needsSub, subs, invoice, ruleFrom]);
}
