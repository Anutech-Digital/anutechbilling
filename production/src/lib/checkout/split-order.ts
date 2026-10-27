/**
 * R-1985 — ONE Razorpay payment that pays TWO quotes of one website order: a monthly (flex)
 * Workspace quote and the new domain's own quote (Pardeep, 26 Oct 2026: "usi payment me, alag
 * invoice"). Shared by the checkout route (which writes the order), the webhook and the
 * checkout/verify path (which split the payment).
 *
 * How the pieces are tied together, all written by OUR server, never by the browser:
 *   - both quotes hang off the SAME lead (the checkout creates one lead per order);
 *   - both carry the Razorpay order id in quotes.payment_reference until paid — record_payment
 *     then replaces it with the payment id on each, so a repeat delivery still finds both;
 *   - the order's notes name the quotes and their shares (splitQuoteIds / splitShares), for the
 *     Razorpay dashboard and the desk. The shares used are each quote's OWN amount from the DB.
 *
 * Each quote then invoices itself: the Workspace quote through the subscription instalment
 * (R-1974), the domain quote through generate_invoice. supabase/tests/
 * r1985_monthly_domain_split.test.sql proves one reference → two payments, two paid invoices,
 * month 2 pending, the books balanced.
 */
import type { createAdminClient } from "@/lib/supabase/server";

type Admin = ReturnType<typeof createAdminClient>;

/** The domain quote's plan label — a domain registration, not a Workspace plan. */
export const DOMAIN_QUOTE_PLAN = "domain-registration";

/** GST-inclusive amount of one taxable value, the way the checkout computes every order total. */
export const withGst = (taxable: number) => Math.round(taxable * 1.18);

export interface SplitPart { quoteId: string; amount: number }

/** Razorpay order notes for a payment split over several quotes (Razorpay notes are strings). */
export function splitOrderNotes(parts: SplitPart[]): Record<string, string> {
  return {
    splitQuoteIds: parts.map((p) => p.quoteId).join(","),
    splitShares: parts.map((p) => String(p.amount)).join(","),
  };
}

type QuoteRef = { id: string; tenant_id: string; lead_id: string | null; amount: number | null; plan?: string | null };

/**
 * The quotes this one Razorpay payment pays, Workspace first, domain quote last — or null when
 * it pays only `quote` (every order except monthly + new domain). Found by the order's lead and
 * by the order id / payment id on quotes.payment_reference, inside the quote's own tenant.
 */
export async function splitOrderParts(
  admin: Admin,
  args: { quote: QuoteRef; orderId: string; paymentId?: string | null },
): Promise<SplitPart[] | null> {
  const { quote, orderId, paymentId } = args;
  if (!quote.lead_id) return null;
  const refs = [orderId, paymentId].filter((r): r is string => Boolean(r));
  const { data, error } = await admin
    .from("quotes")
    .select("id, tenant_id, lead_id, amount, plan")
    .eq("tenant_id", quote.tenant_id)
    .eq("lead_id", quote.lead_id)
    .in("payment_reference", refs)
    .limit(5);
  if (error) return null;
  const others = ((data ?? []) as QuoteRef[]).filter((r) => r.id !== quote.id);
  if (others.length === 0) return null;
  const all = [quote, ...others];
  const rank = (q: QuoteRef) => (q.plan === DOMAIN_QUOTE_PLAN ? 1 : 0);
  return all
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
    .map((q) => ({ quoteId: q.id, amount: Number(q.amount ?? 0) }));
}
