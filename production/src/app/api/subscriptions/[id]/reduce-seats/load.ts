/**
 * R-2252 — server reads for Reduce seats: the part's tax invoice and its money, read the SAME
 * way reduce_subscription_seats() (migration 20261108013626) reads them, so the preview's split
 * is the split the server books.
 *
 *   billed in parts → the subscription_billings row covering today (its invoice_id; none → none);
 *   yearly          → the newest issued invoice of the sale quote or a renewal quote of this
 *                     subscription — never the pending renewal_quote_id (the NEXT term).
 *   received        → receipts + adjusted advances not refunded; a Paid invoice at least its value
 *                     (issue_credit_note_core's "settled").
 */
import type { createAdminClientFor } from "@/lib/supabase/server";
import { isSplitBilled } from "@/lib/billing/instalments";
import { openInvoiceDue } from "@/lib/subscriptions/cancel-due";
import { isPlanChangeQuote } from "@/lib/subscriptions/change-plan";
import type { ReductionInvoiceMoney } from "@/lib/subscriptions/seat-reduction";
import type { Subscription } from "@/lib/supabase/database.types";

type Admin = ReturnType<typeof createAdminClientFor>;

export const REDUCE_SEATS_SELECT =
  "id, tenant_id, customer_id, customer_name, plan, vendor, domain, seats, mrr, start_date, renewal_date, status, billing_cycle, term_months, quote_id, renewal_quote_id, written_off_at" as const;

export interface ReduceSeatsSub {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  vendor: string | null;
  seats: number;
  mrr: number;
  start_date: string | null;
  renewal_date: string | null;
  status: string;
  billing_cycle: Subscription["billing_cycle"];
  term_months: Subscription["term_months"];
  quote_id: string | null;
  renewal_quote_id: string | null;
  written_off_at: string | null;
}

export interface ScheduledReduction {
  id: string;
  seats_before: number;
  seats_after: number;
  effective_date: string;
}

async function partInvoiceId(supabase: Admin, sub: ReduceSeatsSub, today: string): Promise<string | null> {
  if (isSplitBilled(sub.billing_cycle)) {
    const { data } = await supabase
      .from("subscription_billings")
      .select("invoice_id")
      .eq("subscription_id", sub.id)
      .lte("period_start", today)
      .gt("period_end", today)
      .order("term_start", { ascending: false })
      .order("period_index", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as { invoice_id: string | null } | null)?.invoice_id ?? null;
  }
  const { data: renewals } = await supabase
    .from("quotes")
    .select("id")
    .eq("tenant_id", sub.tenant_id)
    .eq("renewal_subscription_id", sub.id);
  const quoteIds = [
    sub.quote_id,
    ...((renewals ?? []) as Array<{ id: string }>).map((q) => q.id).filter((id) => id !== sub.renewal_quote_id),
  ].filter((id): id is string => Boolean(id));
  if (quoteIds.length === 0) return null;
  /* It must be THIS term's bill: raised no earlier than a month before the term began (as the SQL). */
  let query = supabase
    .from("invoices")
    .select("id")
    .eq("tenant_id", sub.tenant_id)
    .in("quote_id", quoteIds)
    .not("status", "in", "(draft,void)");
  const termFrom = termStartFloor(sub);
  if (termFrom) query = query.gte("invoice_date", termFrom);
  const { data } = await query
    .order("invoice_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/** renewal_date − term months − 31 days (the SQL's floor), YYYY-MM-DD; null without a renewal date. */
export function termStartFloor(sub: Pick<ReduceSeatsSub, "renewal_date" | "term_months">): string | null {
  if (!sub.renewal_date) return null;
  const d = new Date(`${sub.renewal_date.slice(0, 10)}T00:00:00Z`);
  const months = Math.max(1, sub.term_months ?? 12);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  d.setUTCDate(d.getUTCDate() - 31);
  return d.toISOString().slice(0, 10);
}

const sum = (rows: unknown, key = "amount") =>
  ((rows ?? []) as Array<Record<string, unknown>>).reduce((s, r) => s + (Number(r[key]) || 0), 0);

/** The part's tax invoice and the money the split reads, or null when the part has none. */
export async function loadPartInvoiceMoney(supabase: Admin, sub: ReduceSeatsSub, today: string): Promise<ReductionInvoiceMoney | null> {
  const id = await partInvoiceId(supabase, sub, today);
  if (!id) return null;
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, status, amount, net_payable, paid_amount, adjusted_advances, written_off_at")
    .eq("id", id)
    .eq("tenant_id", sub.tenant_id)
    .maybeSingle();
  const row = inv as {
    id: string; status: string | null; amount: number | null; net_payable: number | null; paid_amount: number | null;
    adjusted_advances: unknown; written_off_at: string | null;
  } | null;
  if (!row || row.status === "draft" || row.status === "void") return null;

  const advances = Array.isArray(row.adjusted_advances) ? (row.adjusted_advances as Array<{ payment_id?: string; amount?: number }>) : [];
  const advIds = advances.map((a) => a.payment_id).filter((x): x is string => Boolean(x));
  const [cns, dns, refunded, credits] = await Promise.all([
    supabase.from("credit_notes").select("amount").eq("invoice_id", id),
    supabase.from("debit_notes").select("amount").eq("invoice_id", id),
    advIds.length
      ? supabase.from("payments").select("id").in("id", advIds).eq("status", "refunded")
      : Promise.resolve({ data: [] as Array<{ id: string }> }),
    supabase.from("customer_credits").select("amount").eq("tenant_id", sub.tenant_id).eq("source", "credit_note").eq("source_invoice_id", id),
  ]);
  const refundedIds = new Set(((refunded.data ?? []) as Array<{ id: string }>).map((p) => p.id));
  const adv = advances.filter((a) => !a.payment_id || !refundedIds.has(a.payment_id)).reduce((s, a) => s + (Number(a.amount) || 0), 0);
  const cnSum = sum(cns.data);
  const dnSum = sum(dns.data);
  let received = (row.paid_amount ?? 0) + adv;
  if (row.status === "paid") received = Math.max(received, (row.amount ?? 0) + dnSum - cnSum);
  return {
    id,
    openDue: openInvoiceDue(row),
    received,
    alreadyCredited: sum(credits.data),
    creditable: Math.max(0, (row.amount ?? 0) - cnSum),
    writtenOff: Boolean(row.written_off_at),
  };
}

/**
 * A seat cut already scheduled for the end of the term, if any. R-2584: one dated before today
 * (IST) is stale — its renewal passed without it being applied — so it is not returned and blocks
 * nothing (reduce_subscription_seats, migration 20261108043428, skips it the same way).
 */
export async function loadScheduledReduction(supabase: Admin, sub: ReduceSeatsSub, today: string): Promise<ScheduledReduction | null> {
  const { data } = await supabase
    .from("subscription_seat_reductions" as never)
    .select("id, seats_before, seats_after, effective_date")
    .eq("subscription_id", sub.id)
    .eq("tenant_id", sub.tenant_id)
    .eq("status", "scheduled")
    .gte("effective_date", today)
    .order("effective_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as ScheduledReduction | null) ?? null;
}

/**
 * R-2583 — the linked renewal quote that was already made WITH the scheduled cut (lib/renewals/
 * create-renewal-quote.ts bills a scheduled cut): a renewal quote (buys time) for exactly the cut's
 * seats. Removing the cut must not leave that quote at the lower seats — DELETE refuses until the
 * quote is deleted (then it is made again at the current seats).
 */
export async function loadCutRenewalQuote(
  supabase: Admin, sub: ReduceSeatsSub, scheduled: ScheduledReduction | null,
): Promise<{ id: string; seats: number } | null> {
  if (!sub.renewal_quote_id || !scheduled) return null;
  const { data } = await supabase
    .from("quotes")
    .select("id, seats, is_renewal, extension_months")
    .eq("id", sub.renewal_quote_id)
    .eq("tenant_id", sub.tenant_id)
    .maybeSingle();
  const q = data as { id: string; seats: number | null; is_renewal: boolean | null; extension_months: number | null } | null;
  if (!q || !q.is_renewal || (q.extension_months ?? 0) <= 0) return null;
  return q.seats === scheduled.seats_after && scheduled.seats_after < sub.seats ? { id: q.id, seats: q.seats } : null;
}

/**
 * R-2589 — the open plan-change quote of this subscription (Change plan, R-2227), if any: linked
 * through renewal_quote_id, extension_months 0, first line plan_change. It was priced on today's
 * seats and, once paid, sets its own seat count — so a seat cut while it is open would be credited
 * twice. reduce_subscription_seats (migration 20261108051500) refuses the same case.
 */
export async function loadOpenPlanChangeQuote(supabase: Admin, sub: ReduceSeatsSub): Promise<string | null> {
  if (!sub.renewal_quote_id) return null;
  const { data } = await supabase
    .from("quotes")
    .select("id, extension_months, line_items")
    .eq("id", sub.renewal_quote_id)
    .eq("tenant_id", sub.tenant_id)
    .maybeSingle();
  const q = data as { id: string; extension_months: number | null; line_items: unknown } | null;
  return q && isPlanChangeQuote(q) ? q.id : null;
}
