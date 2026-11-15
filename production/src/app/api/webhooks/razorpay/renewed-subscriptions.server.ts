/**
 * R-2852 — which subscriptions a paid renewal quote renews, read BEFORE record_payment rolls them
 * forward and clears the link.
 *
 * A single renewal quote: the one subscription whose `renewal_quote_id` points at it (as before).
 * A quote billed TOGETHER (R-2847): 2+ subscriptions point at it, so the old `.maybeSingle()` errored,
 * returned nothing and the webhook logged "a renewal quote but no subscription points at it" on every
 * paid together quote — and would have queued no domain / hosting renewal (rev-r2849 H1 / L3). Its
 * members are its live renewal_quote_subscriptions rows.
 *
 * paymentShare(): the part of THIS payment a member's renewal gets — the payment split by each member's
 * own subtotal (so the shares add up to what was paid, whatever the discount / GST); a single quote's
 * share is the whole payment. The vendor renew queue's spend check reads it per row.
 *
 * Every paid quote is looked up, as before: a quote linked from a subscription is a renewal even when
 * it is not marked is_renewal (never read as a new sale from its lines).
 */

export interface RenewedSubscription {
  id: string;
  domain: string | null;
  vendor: string | null;
  /** This member's own subtotal on a together quote (its weight in paymentShare); null on a single quote. */
  weight: number | null;
}

export interface RenewedSubscriptions {
  together: boolean;
  subs: RenewedSubscription[];
  /** A problem worth a loud log line (nothing is guessed from it). */
  problem: string | null;
}

type Res = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
interface Chain extends Res { eq(c: string, v: unknown): Chain; in(c: string, v: unknown[]): Chain; is(c: string, v: null): Chain; limit(n: number): Chain }
export interface RenewedReadClient { from(table: string): { select(cols: string): Chain } }

const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

export async function renewedSubscriptionsOf(
  admin: RenewedReadClient,
  quote: { id: string; tenant_id: string },
): Promise<RenewedSubscriptions> {
  const { data: links, error: linkErr } = await admin
    .from("renewal_quote_subscriptions")
    .select("subscription_id, subtotal")
    .eq("tenant_id", quote.tenant_id)
    .eq("quote_id", quote.id)
    .is("released_at", null);
  const linkRows = (linkErr ? [] : (links as { subscription_id: string; subtotal: number | null }[] | null) ?? []);
  if (linkErr && !MISSING_TABLE.has(linkErr.code ?? "")) {
    return { together: false, subs: [], problem: `its billed-together rows could not be read (${linkErr.message})` };
  }

  if (linkRows.length > 0) {
    const { data, error } = await admin
      .from("subscriptions")
      .select("id, domain, vendor")
      .eq("tenant_id", quote.tenant_id)
      .in("id", linkRows.map((l) => l.subscription_id));
    if (error) return { together: true, subs: [], problem: `the subscriptions it renews could not be read (${error.message})` };
    const subtotalOf = new Map(linkRows.map((l) => [l.subscription_id, Math.max(0, Number(l.subtotal) || 0)]));
    const subs = ((data ?? []) as { id: string; domain: string | null; vendor: string | null }[]).map((s) => ({
      ...s,
      weight: subtotalOf.get(s.id) ?? 0,
    }));
    return { together: true, subs, problem: subs.length < linkRows.length ? "some of the subscriptions it renews were not found" : null };
  }

  const { data, error } = await admin
    .from("subscriptions")
    .select("id, domain, vendor")
    .eq("tenant_id", quote.tenant_id)
    .eq("renewal_quote_id", quote.id)
    .limit(2);
  if (error) return { together: false, subs: [], problem: `the subscription it renews could not be read (${error.message})` };
  const rows = (data ?? []) as { id: string; domain: string | null; vendor: string | null }[];
  if (rows.length > 1) {
    /* Two subscriptions linked with no billed-together rows: not a shape any path makes. Never guess which. */
    return { together: false, subs: [], problem: "more than one subscription points at it but it is not billed together" };
  }
  return { together: false, subs: rows.map((s) => ({ ...s, weight: null })), problem: null };
}

/** The part of `paymentAmount` (₹) that `subscriptionId`'s renewal gets — see the header. */
export function paymentShare(renewed: RenewedSubscriptions, subscriptionId: string, paymentAmount: number): number {
  if (!renewed.together) return paymentAmount;
  const total = renewed.subs.reduce((n, s) => n + (s.weight ?? 0), 0);
  const mine = renewed.subs.find((s) => s.id === subscriptionId)?.weight ?? 0;
  return total > 0 ? Math.floor((paymentAmount * mine) / total) : 0;
}
