/**
 * R-375 (7 Oct 2026, money-flow audit finding 8) — "is this won deal backed by money?".
 *
 * `accept_quote` moves `leads.stage` to 'won' the moment a quote is ACCEPTED — before any
 * payment. A project quotation accepted in Project Sales does the same (migration
 * 20260926120000). So a lead's stage is a promise, not revenue, and every "won ₹" figure
 * (dashboard Deals strip, Reports Deals card, marketing channel ROAS) that summed
 * `leads.value` over stage = 'won' counted accepted-but-unpaid quotes as won revenue.
 *
 * The rule here is the one the online-orders page settled on (R-351, order-payment.ts):
 * the money lives on the QUOTE — `record_payment` (Razorpay webhook, test checkout, desk) is
 * the only writer of `quotes.payment_status`, moving it to 'partial' / 'received', then
 * 'invoiced'. A project deal's money lives in `project_payments` (one row per receipt, TDS
 * included), linked through `leads.project_id`.
 *
 * A won deal counts as won REVENUE when a payment exists: any of its quotes is part- or
 * fully-paid, or its project has at least one receipt.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fetchAllRowsIn } from "@/lib/ops/fetch-all";

export type PaymentState = "paid" | "partial" | "none";

/** quote.payment_status values that mean the full amount was recorded. */
const FULLY_PAID: ReadonlySet<string> = new Set(["received", "invoiced"]);

/** What one quote's `payment_status` says was recorded. The single source of the rule. */
export function quotePaymentState(status: string | null | undefined): PaymentState {
  const s = (status ?? "").trim();
  return FULLY_PAID.has(s) ? "paid" : s === "partial" ? "partial" : "none";
}

export interface LeadMoneyLink {
  id: string;
  /** leads.project_id — a custom-software deal's project quotation, or null. */
  project_id?: string | null;
}

export interface QuotePaymentLink {
  lead_id: string | null;
  payment_status: string | null;
}

/**
 * Lead ids (of `leads`) with a recorded payment: a part- or fully-paid quote, or a project
 * with at least one receipt (`paidProjectIds` = project ids that have a project_payments row).
 */
export function leadsWithPayment(
  leads: readonly LeadMoneyLink[],
  quotes: readonly QuotePaymentLink[],
  paidProjectIds: Iterable<string>,
): Set<string> {
  const wanted = new Set(leads.map((l) => l.id));
  const out = new Set<string>();
  for (const q of quotes) {
    const id = q.lead_id?.trim();
    if (id && wanted.has(id) && quotePaymentState(q.payment_status) !== "none") out.add(id);
  }
  const projects = new Set(paidProjectIds);
  for (const l of leads) {
    if (l.project_id && projects.has(l.project_id)) out.add(l.id);
  }
  return out;
}

/**
 * Read the quotes + project receipts behind `leads` (under the caller's RLS) and return the
 * ids that have a recorded payment. Paged + chunked, so nothing is cut at 1000 rows.
 */
export async function fetchPaidLeadIds(
  supabase: SupabaseClient<Database>,
  leads: readonly LeadMoneyLink[],
): Promise<Set<string>> {
  if (leads.length === 0) return new Set();
  const projectIds = leads.map((l) => l.project_id ?? null);
  const [quotes, receipts] = await Promise.all([
    fetchAllRowsIn(leads.map((l) => l.id), (ids, from, to) => supabase
      .from("quotes").select("id, lead_id, payment_status")
      .in("lead_id", ids)
      .order("id", { ascending: true })
      .range(from, to)),
    fetchAllRowsIn(projectIds, (ids, from, to) => supabase
      .from("project_payments").select("id, project_id")
      .in("project_id", ids)
      .order("id", { ascending: true })
      .range(from, to)),
  ]);
  return leadsWithPayment(leads, quotes, receipts.map((r) => r.project_id));
}
