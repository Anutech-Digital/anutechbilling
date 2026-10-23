/**
 * R-1764 — the line-period context for a stored quote, read on the server (quote PDF routes,
 * the quote email, WhatsApp, the tax invoice PDF). A renewal / extension quote stores no domain,
 * so the domain comes from the subscription it renews (quotes.renewal_subscription_id, R-1574,
 * else the subscription whose renewal_quote_id is this quote). Never throws: a failed read only
 * drops the "Domain:" line.
 */
import { quoteLinePeriodContext, type LinePeriodContext } from "@/lib/quotes/service-period";

type QuoteForContext = Parameters<typeof quoteLinePeriodContext>[0] & {
  id: string;
  tenant_id: string;
  renewal_subscription_id?: string | null;
};

// The supabase-js call chains this needs, from either the admin or a user client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: "subscriptions" | "quotes") => any };

const CONTEXT_COLUMNS =
  "id, tenant_id, is_renewal, is_extension, is_add_seats, is_one_off, extension_months, renewal_term_date, renewal_subscription_id, created_date, domain";

/** The context for a quote known only by id (the renewal cron / Send now). Null when unread. */
export async function loadQuotePeriodContextById(db: Db, tenantId: string, quoteId: string | null | undefined): Promise<LinePeriodContext | null> {
  if (!quoteId) return null;
  try {
    const { data } = await db.from("quotes").select(CONTEXT_COLUMNS).eq("id", quoteId).eq("tenant_id", tenantId).maybeSingle();
    return data ? await loadQuotePeriodContext(db, data as QuoteForContext) : null;
  } catch {
    return null;
  }
}

/** The renewed subscription's domain, for a renewal / extension quote that stores none. */
export async function loadRenewedSubscriptionDomain(db: Db, quote: QuoteForContext | null | undefined): Promise<string | null> {
  if (!quote || (quote.domain ?? "").trim()) return null;
  if (quote.is_renewal !== true && quote.is_extension !== true) return null;
  try {
    const base = db.from("subscriptions").select("domain").eq("tenant_id", quote.tenant_id);
    const { data } = await (quote.renewal_subscription_id
      ? base.eq("id", quote.renewal_subscription_id)
      : base.eq("renewal_quote_id", quote.id)
    ).limit(1).maybeSingle();
    return ((data?.domain as string | null | undefined) ?? "").trim() || null;
  } catch {
    return null;
  }
}

export async function loadQuotePeriodContext(db: Db, quote: QuoteForContext): Promise<LinePeriodContext> {
  return quoteLinePeriodContext(quote, await loadRenewedSubscriptionDomain(db, quote));
}
