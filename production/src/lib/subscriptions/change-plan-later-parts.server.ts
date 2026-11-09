/**
 * R-2626 — the parts of a subscription starting AFTER `after` that already have a bill: a live (not
 * void) tax invoice on subscription_billings.invoice_id, or a payment request / proforma linked to the
 * part — directly (quotes.subscription_billing_id, R-2044 / R-2519b) or as a line of a GROUP request
 * (line billing_id, R-2092: the group links only its first part) — that was not spent on an invoice
 * credit notes cancelled (R-2095). Any status, like bill_subscription_instalment: a cancelled proforma
 * is unlinked by cancel_quote, so a request still linked is still that part's request.
 * Same rows the SQL trigger subscriptions_r2626_plan_change_vs_later_part reads (migration 20261109064000).
 *
 * Read by the Change plan route (preview + save) and the online pay start of a plan-change quote.
 * Throws on a failed read — the caller refuses (500) rather than price a change it could not check.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LaterBilledPart } from "./change-plan";

interface BillingRow {
  id: string; period_index: number; period_start: string; period_end: string;
  invoice_id: string | null; credited_invoice_ids: string[] | null;
}
interface RequestRow { id: string; subscription_billing_id: string | null; invoice_id: string | null; line_items: unknown; created_at: string | null }

/** The billing ids a request's lines name (group request, R-2092). */
function lineBillingIds(lineItems: unknown): string[] {
  if (!Array.isArray(lineItems)) return [];
  return lineItems
    .map((l) => (l && typeof l === "object" ? (l as { billing_id?: unknown }).billing_id : null))
    .filter((v): v is string => typeof v === "string" && v !== "");
}

export async function readLaterBilledParts(
  supabase: unknown,
  tenantId: string,
  subscriptionId: string,
  after: string,
): Promise<LaterBilledPart[]> {
  /* subscription_billing_id / credited_invoice_ids are newer than the generated types — read untyped. */
  const db = supabase as SupabaseClient;
  const { data: rows, error } = await db.from("subscription_billings")
    .select("id, period_index, period_start, period_end, invoice_id, credited_invoice_ids")
    .eq("tenant_id", tenantId).eq("subscription_id", subscriptionId)
    .gt("period_start", after.slice(0, 10));
  if (error) throw new Error("Could not read this subscription's billing parts.");
  const parts = (rows ?? []) as BillingRow[];
  if (parts.length === 0) return [];

  const ids = parts.map((p) => p.id);
  const invoiceIds = [...new Set(parts.map((p) => p.invoice_id).filter((v): v is string => !!v))];
  const cols = "id, subscription_billing_id, invoice_id, line_items, created_at";
  const [invs, direct, ...grouped] = await Promise.all([
    invoiceIds.length > 0
      ? db.from("invoices").select("id, status").eq("tenant_id", tenantId).in("id", invoiceIds)
      : Promise.resolve({ data: [], error: null }),
    db.from("quotes").select(cols).eq("tenant_id", tenantId).in("subscription_billing_id", ids),
    /* Group requests: linked through ANOTHER part, naming this one in a line. */
    ...ids.map((id) => db.from("quotes").select(cols).eq("tenant_id", tenantId)
      .not("subscription_billing_id", "is", null)
      .contains("line_items", JSON.stringify([{ billing_id: id }]))),
  ]);
  if (invs.error) throw new Error("Could not read the billing parts' invoices.");
  if (direct.error || grouped.some((g) => g.error)) throw new Error("Could not read the billing parts' payment requests.");

  const liveInvoices = new Set(((invs.data ?? []) as { id: string; status: string | null }[])
    .filter((i) => i.status !== "void").map((i) => i.id));
  const requests = new Map<string, RequestRow>();
  for (const r of [direct, ...grouped].flatMap((g) => (g.data ?? []) as RequestRow[])) requests.set(r.id, r);
  const byTime = [...requests.values()].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));

  return parts.map((p) => {
    const credited = new Set(p.credited_invoice_ids ?? []);
    const req = byTime.find((r) =>
      (r.subscription_billing_id === p.id || (r.subscription_billing_id != null && lineBillingIds(r.line_items).includes(p.id)))
      && !(r.invoice_id != null && credited.has(r.invoice_id)));
    return {
      periodIndex: p.period_index,
      periodStart: String(p.period_start).slice(0, 10),
      periodEnd: String(p.period_end).slice(0, 10),
      invoiceId: p.invoice_id && liveInvoices.has(p.invoice_id) ? p.invoice_id : null,
      requestId: req?.id ?? null,
    };
  });
}
