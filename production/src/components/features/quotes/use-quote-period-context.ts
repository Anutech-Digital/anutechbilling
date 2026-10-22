"use client";
/**
 * R-1764 — the context a saved quote's lines read their "Domain:" and "Subscription period:"
 * from (lib/quotes/service-period.ts). A renewal quote stores no domain, so it is read from the
 * subscription the quote renews. Null quote → null (nothing printed).
 */
import * as React from "react";
import { useCustomerSubscriptions } from "@/lib/queries/subscriptions";
import {
  quoteLinePeriodContext, renewedSubscriptionDomain, type LinePeriodContext,
} from "@/lib/quotes/service-period";
import type { Quote } from "@/lib/supabase/database.types";

export function useQuotePeriodContext(quote: Quote | null | undefined): LinePeriodContext | null {
  const needsSub = !!quote && !(quote.domain ?? "").trim() && (quote.is_renewal || quote.is_extension);
  const { data: subs } = useCustomerSubscriptions(needsSub ? (quote?.customer_id ?? undefined) : undefined);
  return React.useMemo(
    () => (quote ? quoteLinePeriodContext(quote, needsSub ? renewedSubscriptionDomain(quote, subs) : null) : null),
    [quote, needsSub, subs],
  );
}
