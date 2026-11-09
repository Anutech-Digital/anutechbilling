/**
 * R-2626 — the parts of a subscription starting AFTER `after` that already have a bill: a live (not
 * void) tax invoice on subscription_billings.invoice_id, or an open payment request / proforma
 * (quotes.subscription_billing_id, status draft / sent / viewed / accepted — R-2044 / R-2519b).
 * A part freed by credit notes (R-2095 drops invoice_id) or whose proforma was cancelled (rejected,
 * link moved to cancelled_part_billing_id) has no bill. Same rows the SQL trigger
 * subscriptions_r2626_plan_change_vs_later_part reads (migration 20261109064000).
 *
 * Read by the Change plan route (preview + save) and the online pay start of a plan-change quote.
 * Throws on a failed read — the caller refuses (500) rather than price a change it could not check.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LaterBilledPart } from "./change-plan";

/** Payment-request statuses that still ask for money (bill_subscription_instalment's open set). */
export const OPEN_REQUEST_STATUSES = ["draft", "sent", "viewed", "accepted"] as const;

interface BillingRow { id: string; period_index: number; period_start: string; period_end: string; invoice_id: string | null }

export async function readLaterBilledParts(
  supabase: unknown,
  tenantId: string,
  subscriptionId: string,
  after: string,
): Promise<LaterBilledPart[]> {
  /* subscription_billing_id / some billing columns are newer than the generated types — read untyped. */
  const db = supabase as SupabaseClient;
  const { data: rows, error } = await db.from("subscription_billings")
    .select("id, period_index, period_start, period_end, invoice_id")
    .eq("tenant_id", tenantId).eq("subscription_id", subscriptionId)
    .gt("period_start", after.slice(0, 10));
  if (error) throw new Error("Could not read this subscription's billing parts.");
  const parts = (rows ?? []) as BillingRow[];
  if (parts.length === 0) return [];

  const invoiceIds = [...new Set(parts.map((p) => p.invoice_id).filter((v): v is string => !!v))];
  const liveInvoices = new Set<string>();
  if (invoiceIds.length > 0) {
    const { data: invs, error: iErr } = await db.from("invoices").select("id, status")
      .eq("tenant_id", tenantId).in("id", invoiceIds);
    if (iErr) throw new Error("Could not read the billing parts' invoices.");
    for (const i of (invs ?? []) as { id: string; status: string | null }[]) {
      if (i.status !== "void") liveInvoices.add(i.id);
    }
  }

  const { data: reqs, error: rErr } = await db.from("quotes").select("id, subscription_billing_id, created_at")
    .eq("tenant_id", tenantId).in("subscription_billing_id", parts.map((p) => p.id))
    .in("status", [...OPEN_REQUEST_STATUSES])
    .order("created_at", { ascending: true });
  if (rErr) throw new Error("Could not read the billing parts' payment requests.");
  const requestOf = new Map<string, string>();
  for (const r of (reqs ?? []) as { id: string; subscription_billing_id: string | null }[]) {
    if (r.subscription_billing_id && !requestOf.has(r.subscription_billing_id)) requestOf.set(r.subscription_billing_id, r.id);
  }

  return parts.map((p) => ({
    periodIndex: p.period_index,
    periodStart: String(p.period_start).slice(0, 10),
    periodEnd: String(p.period_end).slice(0, 10),
    invoiceId: p.invoice_id && liveInvoices.has(p.invoice_id) ? p.invoice_id : null,
    requestId: requestOf.get(p.id) ?? null,
  }));
}
