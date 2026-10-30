/**
 * R-2070 (decision D4, 29 Oct 2026) — the read/write half of the support-plan pause.
 * Called from /api/cron/invoice-dunning after the R-116 pass, with the same service-role
 * client, the same `?dry=1` rules and the unpaid invoices that cron already read.
 *
 * Per ACTIVE support subscription (catalogue SKU "SUP-…"), every company:
 *   oldest unpaid invoice that bills it (its source quote, or its subscription_billings)
 *   more than SUPPORT_GRACE_DAYS past due → status 'paused' + suspended_at / suspend_reason /
 *   suspended_by 'automation' / suspended_invoice_id, and an ai_action_log row.
 *
 * Why 'paused' and not a new 'suspended' status: 'paused' + suspended_by/suspended_invoice_id
 * is already the app's "paused for an unpaid invoice" (R-116, R-1681) — every screen knows it,
 * the support app's sync already reads 'paused' as suspended, and paying the invoice turns it
 * back on through the existing trigger trg_invoices_overdue_resume. A new enum value would
 * need every status list, the trigger and the support-sync mapping changed for no gain.
 *
 * Linking by quote: unlike R-116 this does not require the quote to have ONE subscription. A
 * quote that sold Workspace + Support makes two subscriptions on one invoice; when that
 * invoice is unpaid it is also the support plan's invoice, and the pause is aimed at the
 * support subscription only — the Workspace one is never touched here.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { istToday } from "@/lib/dates/ist";
import { cronTenantAllowed } from "@/lib/automation/cron-gate";
import {
  SUPPORT_GRACE_DAYS,
  decideSupportOverduePause,
  isSupportItem,
  oldestOverdueInvoice,
  type OverdueInvoice,
} from "./overdue-suspension";

type Admin = ReturnType<typeof createAdminClient>;

export interface SupportPauseInvoice extends OverdueInvoice {
  tenant_id: string;
  quote_id: string | null;
}

export interface SupportPauseResult {
  subscriptions_checked: number;
  suspends: number;
  details: { subscription_id: string; invoice_id: string; action: "suspend"; days_overdue: number; reason: string }[];
  errors: { subscription_id: string; message: string }[];
}

interface SubRow {
  id: string; tenant_id: string; customer_name: string; plan: string;
  quote_id: string | null; item_id: string | null; status: string;
}

export async function runSupportOverduePause(
  supabase: Admin,
  opts: {
    asOf: Date;
    dryRun: boolean;
    /** The unpaid (pending/overdue, not written off, with a due date) invoices the cron read. */
    invoices: readonly SupportPauseInvoice[];
    /** R-346: "activate now, pay later" quotes — never paused automatically. */
    creditQuoteIds: ReadonlySet<string>;
  },
): Promise<SupportPauseResult> {
  const result: SupportPauseResult = { subscriptions_checked: 0, suspends: 0, details: [], errors: [] };
  const today = istToday(opts.asOf);

  /* Support SKUs carry vendor 'support'; the id prefix is the real test (isSupportItem). */
  const items = await fetchAllRows<{ id: string }>((from, to) => supabase
    .from("items").select("id").eq("vendor", "support")
    .order("id", { ascending: true }).range(from, to));
  const supportItemIds = items.map((i) => i.id).filter(isSupportItem);
  if (supportItemIds.length === 0) return result;

  const subs = (await fetchAllRowsIn(supportItemIds, (ids, from, to) => supabase
    .from("subscriptions")
    .select("id, tenant_id, customer_name, plan, quote_id, item_id, status")
    .in("item_id", ids).eq("status", "active")
    .order("id", { ascending: true }).range(from, to)) as SubRow[])
    .filter((s) => isSupportItem(s.item_id));
  if (subs.length === 0) return result;

  const chaseable = opts.invoices.filter((i) => !(i.quote_id && opts.creditQuoteIds.has(i.quote_id)));
  const invById = new Map(chaseable.map((i) => [i.id, i]));
  const invByQuote = new Map<string, SupportPauseInvoice[]>();
  for (const i of chaseable) {
    if (!i.quote_id) continue;
    const key = `${i.tenant_id}|${i.quote_id}`;
    invByQuote.set(key, [...(invByQuote.get(key) ?? []), i]);
  }

  const billings = await fetchAllRowsIn(subs.map((s) => s.id), (ids, from, to) => supabase
    .from("subscription_billings")
    .select("subscription_id, invoice_id")
    .in("subscription_id", ids).not("invoice_id", "is", null)
    .order("id", { ascending: true }).range(from, to)) as { subscription_id: string; invoice_id: string | null }[];
  const billedInv = new Map<string, SupportPauseInvoice[]>();
  for (const b of billings) {
    const inv = b.invoice_id ? invById.get(b.invoice_id) : undefined;
    if (inv) billedInv.set(b.subscription_id, [...(billedInv.get(b.subscription_id) ?? []), inv]);
  }

  for (const sub of subs) {
    /* R-897 */ if (!cronTenantAllowed(sub.tenant_id)) continue;
    result.subscriptions_checked++;
    const linked = new Map<string, SupportPauseInvoice>();
    if (sub.quote_id) for (const i of invByQuote.get(`${sub.tenant_id}|${sub.quote_id}`) ?? []) linked.set(i.id, i);
    for (const i of billedInv.get(sub.id) ?? []) if (i.tenant_id === sub.tenant_id) linked.set(i.id, i);

    const oldest = oldestOverdueInvoice([...linked.values()], today);
    const decision = decideSupportOverduePause({ subscriptionStatus: sub.status, oldest });
    if (decision.action !== "suspend" || !oldest) continue;

    result.details.push({
      subscription_id: sub.id, invoice_id: oldest.invoiceId, action: "suspend",
      days_overdue: decision.daysOverdue, reason: decision.reason,
    });
    if (opts.dryRun) continue;

    try {
      /* Guarded on status 'active': a subscription somebody changed since the read is left alone. */
      const { error: updErr } = await supabase
        .from("subscriptions")
        .update({
          status: "paused",
          suspended_at: opts.asOf.toISOString(),
          suspend_reason: decision.reason,
          suspended_by: "automation",
          suspended_invoice_id: oldest.invoiceId,
        })
        .eq("id", sub.id).eq("tenant_id", sub.tenant_id).eq("status", "active");
      if (updErr) throw updErr;
      result.suspends++;

      const { error: logErr } = await supabase.from("ai_action_log").insert({
        tenant_id: sub.tenant_id,
        action: "subscription.support_overdue_suspend",
        outcome: "did",
        mode: "auto",
        reason: decision.reason,
        entity: "subscription",
        entity_id: sub.id,
        facts: {
          invoice_id: oldest.invoiceId, days_overdue: decision.daysOverdue,
          grace_days: SUPPORT_GRACE_DAYS, plan: sub.plan, actor: "automation",
        },
      });
      if (logErr) console.error("[support-overdue-pause] ai_action_log insert failed:", logErr.message);
    } catch (e) {
      const message = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
      result.errors.push({ subscription_id: sub.id, message });
    }
  }
  return result;
}
