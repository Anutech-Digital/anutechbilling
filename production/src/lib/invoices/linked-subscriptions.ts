/**
 * R-1433: which subscriptions an invoice belongs to, for the card on /invoices/[id].
 *
 * An invoice reaches a subscription three ways, and all three are real:
 *  - its quote made the subscription      → subscriptions.quote_id         = the quote
 *  - its quote renewed the subscription   → subscriptions.renewal_quote_id = the quote
 *  - it is a scheduled instalment         → subscription_billings.invoice_id = the invoice
 * "The quote" is invoices.quote_id, or the quote whose invoice_id is this invoice (older rows
 * keep only that side). Read under RLS on the browser client, so another tenant's rows never come.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { subscriptionCycle } from "@/lib/subscriptions/billing-cycle";
import { subscriptionStatusLabel } from "@/app/(app)/subscriptions/palette-links";
import { subscriptionOpenHref } from "@/app/(app)/subscriptions/open-link";

export const LINKED_SUBSCRIPTION_SELECT =
  "id, plan, domain, customer_name, status, billing_cycle, term_months, start_date, renewal_date, seats" as const;

export interface LinkedSubscriptionRow {
  id: string;
  plan: string;
  domain: string | null;
  customer_name: string;
  status: string;
  billing_cycle: string | null;
  term_months: number | null;
  start_date: string | null;
  renewal_date: string | null;
  seats: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uniq = (xs: ReadonlyArray<string | null | undefined>) =>
  [...new Set(xs.map((x) => (x ?? "").trim()).filter((x) => UUID.test(x)))];

/** PostgREST `or=` filter for the subscriptions of these quotes / these ids. "" = nothing to look up. */
export function linkedSubscriptionsFilter(quoteIds: ReadonlyArray<string | null | undefined>, subscriptionIds: ReadonlyArray<string | null | undefined>): string {
  const q = uniq(quoteIds);
  const s = uniq(subscriptionIds);
  const parts: string[] = [];
  if (q.length) parts.push(`quote_id.in.(${q.join(",")})`, `renewal_quote_id.in.(${q.join(",")})`);
  if (s.length) parts.push(`id.in.(${s.join(",")})`);
  return parts.join(",");
}

export async function fetchInvoiceSubscriptions(
  supabase: SupabaseClient<Database>,
  args: { invoiceId: string; quoteIds: ReadonlyArray<string | null | undefined> },
): Promise<LinkedSubscriptionRow[]> {
  const { data: billings, error: bErr } = await supabase
    .from("subscription_billings")
    .select("subscription_id")
    .eq("invoice_id", args.invoiceId)
    .limit(20);
  if (bErr) throw bErr;
  const filter = linkedSubscriptionsFilter(args.quoteIds, (billings ?? []).map((b) => b.subscription_id));
  if (!filter) return [];
  const { data, error } = await supabase
    .from("subscriptions")
    .select(LINKED_SUBSCRIPTION_SELECT)
    .or(filter)
    .order("created_at", { ascending: true })
    .limit(10);
  if (error) throw error;
  return (data ?? []) as LinkedSubscriptionRow[];
}

export interface LinkedSubscriptionView {
  id: string;
  plan: string;
  /** Domain, else the customer — what tells two subscriptions of one customer apart. */
  subtitle: string;
  status: string;
  /** "Annual", "Annual · billed quarterly", "Monthly"… — the list's own words; null = unknown. */
  term: string | null;
  renewalDate: string | null;
  href: string;
}

export function linkedSubscriptionView(s: LinkedSubscriptionRow): LinkedSubscriptionView {
  return {
    id: s.id,
    plan: s.plan,
    subtitle: (s.domain ?? "").trim() || s.customer_name,
    status: subscriptionStatusLabel(s.status),
    term: subscriptionCycle(s).label,
    renewalDate: s.renewal_date,
    href: subscriptionOpenHref(s),
  };
}
