/**
 * R-1764 — the line-period context for a stored quote, read on the server (quote PDF routes,
 * the quote email, WhatsApp, the tax invoice PDF). A renewal / extension quote stores no domain,
 * so the domain comes from the subscription it renews (quotes.renewal_subscription_id, R-1574,
 * else the subscription whose renewal_quote_id is this quote). Never throws: a failed read only
 * drops the "Domain:" line.
 */
import {
  quoteLinePeriodContext, R2727_PERIOD_RULE_KEY, type LinePeriodContext, type RenewedSubscriptionFacts,
} from "@/lib/quotes/service-period";

type QuoteForContext = Parameters<typeof quoteLinePeriodContext>[0] & {
  id: string;
  tenant_id: string;
  renewal_subscription_id?: string | null;
};

// The supabase-js call chains this needs, from either the admin or a user client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: "subscriptions" | "quotes" | "app_rule_dates" | "renewal_quote_subscriptions") => any };

/**
 * R-2849 — the subscriptions a together renewal quote renews (renewal_quote_subscriptions, R-2847 — kept after payment
 * and after release, so an old quote / its invoice still finds them): each line's start + term + domain by id; the
 * first line's facts lead (domain of the quote). Null = not a together quote, or unread (the caller's single path then).
 */
async function loadTogetherSubscriptions(db: Db, quote: QuoteForContext): Promise<RenewedSubscriptionFacts | null> {
  try {
    const { data: links, error } = await db.from("renewal_quote_subscriptions").select("subscription_id, line_no")
      .eq("tenant_id", quote.tenant_id).eq("quote_id", quote.id).order("line_no", { ascending: true });
    const rows = (error ? [] : (links ?? [])) as Array<{ subscription_id: string }>;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const ids = [...new Set(rows.map((r) => r.subscription_id))];
    const { data: subs, error: sErr } = await db.from("subscriptions").select("id, domain, start_date, term_months")
      .eq("tenant_id", quote.tenant_id).in("id", ids);
    if (sErr || !Array.isArray(subs)) return null;
    const lines: Record<string, RenewedSubscriptionFacts> = {};
    for (const s of subs as Array<{ id: string; domain: string | null; start_date: string | null; term_months: number | null }>) {
      lines[s.id] = { domain: (s.domain ?? "").trim() || null, start_date: s.start_date ?? null, term_months: s.term_months ?? null };
    }
    const lead = lines[ids[0]] ?? {};
    return { ...lead, lines };
  } catch {
    return null;
  }
}

/** R-2727 review (MED): when the invoice period rule went live on THIS database — app_rule_dates
 *  (key R2727_PERIOD_RULE_KEY, inserted by migration 20261113181025 with now()). Null when the row is
 *  not there yet or unreadable: the invoice PDF then keeps the old rule (never throws). */
export async function loadInvoicePeriodRuleFrom(db: Pick<Db, "from">): Promise<string | null> {
  try {
    const { data } = await db.from("app_rule_dates").select("from_at").eq("key", R2727_PERIOD_RULE_KEY).maybeSingle();
    const at = (data as { from_at?: string | null } | null)?.from_at ?? null;
    return typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : null;
  } catch {
    return null;
  }
}

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

/** R-2727: the subscription a renewal / extension quote renews — its domain (the quote stores none)
 *  and its start + term, which decide where the next term starts (billing's followingTermStart).
 *  Read even when the quote has its own domain. Null when not a renewal / unread (never throws). */
export async function loadRenewedSubscription(db: Db, quote: QuoteForContext | null | undefined): Promise<RenewedSubscriptionFacts | null> {
  if (!quote) return null;
  if (quote.is_renewal !== true && quote.is_extension !== true) return null;
  /* R-2849: a renewal quote billed together (R-2847) names no one subscription — its link rows name each line's. */
  if (!quote.renewal_subscription_id) {
    const together = await loadTogetherSubscriptions(db, quote);
    if (together) return together;
  }
  try {
    const base = db.from("subscriptions").select("domain, start_date, term_months").eq("tenant_id", quote.tenant_id);
    const { data } = await (quote.renewal_subscription_id
      ? base.eq("id", quote.renewal_subscription_id)
      : base.eq("renewal_quote_id", quote.id)
    ).limit(1).maybeSingle();
    if (!data) {
      warnPeriodFallback(quote, "renewed subscription not found");
      return null;
    }
    return {
      domain: ((data.domain as string | null | undefined) ?? "").trim() || null,
      start_date: (data.start_date as string | null | undefined) ?? null,
      term_months: (data.term_months as number | null | undefined) ?? null,
    };
  } catch (err) {
    warnPeriodFallback(quote, err instanceof Error ? err.message : "read failed");
    return null;
  }
}

/** R-2727 review (MED): the period then falls back to the day after renewal_term_date (the rule
 *  before R-2727) — said in the server log (tenant + quote id only, no customer data). */
function warnPeriodFallback(quote: QuoteForContext, why: string): void {
  console.warn(`[line-period] tenant ${quote.tenant_id} quote ${quote.id}: renewed subscription not read (${why}) — renewal period uses the day after renewal_term_date`);
}

/** The renewed subscription's domain, for a renewal / extension quote that stores none. */
export async function loadRenewedSubscriptionDomain(db: Db, quote: QuoteForContext | null | undefined): Promise<string | null> {
  if (!quote || (quote.domain ?? "").trim()) return null;
  return (await loadRenewedSubscription(db, quote))?.domain ?? null;
}

export async function loadQuotePeriodContext(db: Db, quote: QuoteForContext): Promise<LinePeriodContext> {
  return quoteLinePeriodContext(quote, await loadRenewedSubscription(db, quote));
}
