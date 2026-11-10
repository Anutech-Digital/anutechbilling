/**
 * R-2227 — the money of the part (or yearly term) a plan change falls in, read on the SERVER,
 * for splitChangeCredit (R-2255) inside buildPlanChange(). The route calls this; the browser never
 * supplies these figures, so the credit on the quote is always what the books say.
 *
 *   billed elsewhere (Zoho import / opening, R-1763 / R-2097) → paid outside this app, in full;
 *   billed in parts → the current part's subscription_billings row and ITS INVOICE. No invoice yet
 *                     (nothing raised, or only a payment request) → `billed: false`: the billing run
 *                     re-prices an un-invoiced part to the new MRR (sync-instalments), so charging the
 *                     rest of it here too would bill those days twice;
 *   yearly-paid     → the term's invoices: the sale / renewal / add-seats quotes' invoices dated from
 *                     31 days before the term start (a renewal is invoiced up to ~30 days early) to 31
 *                     days before its end (the NEXT term's early renewal invoice is not this term's).
 *
 * Earlier plan changes in the same window (quotes whose first line carries `plan_change` for this
 * subscription and covers today) that were PAID (a received payment — the invoice may come later):
 * the money received on them counts for the part, and the credit they already gave is subtracted
 * (alreadyCredited), so a second change never gives the same unused value back twice.
 *
 * All figures returned in PAISE incl. GST (DB columns are rupees).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { isSplitBilled } from "@/lib/billing/instalments";
import { subscriptionSchedule, currentTermStart, followingTermStart } from "@/lib/billing/subscription-schedule";
import { addDaysISO } from "@/lib/billing/schedule";
import { billedElsewhere } from "./billed-elsewhere";
import { openInvoiceDue, type SubInvoiceRow } from "./cancel-due";
import { rupeesToPaise } from "./proration";
import type { ChangePlanMoney, PlanChangeMeta } from "./change-plan";

type Admin = SupabaseClient<Database>;

export interface MoneySub {
  id: string;
  quote_id: string | null;
  mrr: number;
  billing_cycle: string | null;
  term_months: number | null;
  start_date: string | null;
  renewal_date: string | null;
  term_amount?: number | null;
  external_source?: string | null;
  billed_externally_until?: string | null;
}

const INVOICE_COLS = "id, status, amount, net_payable, paid_amount, written_off_at, invoice_date, quote_id";
type InvoiceRow = SubInvoiceRow & { invoice_date: string | null; quote_id: string | null };

const live = (i: InvoiceRow) => i.status !== "void" && i.status !== "draft";
const paidPaise = (i: InvoiceRow) => rupeesToPaise(Math.max(0, i.paid_amount ?? 0));

export async function readPlanChangeMoney(supabase: Admin, tenantId: string, sub: MoneySub, today: string): Promise<ChangePlanMoney> {
  const none: ChangePlanMoney = { billed: false, openDuePaise: 0, receivedPaise: 0, alreadyCreditedPaise: 0, invoiced: false };
  const split = isSplitBilled(sub.billing_cycle as never);
  const schedSub = sub as Parameters<typeof subscriptionSchedule>[0];
  const part = split ? subscriptionSchedule(schedSub).find((p) => p.periodStart <= today && today < p.periodEnd) : null;
  const windowStart = part ? part.periodStart : currentTermStart(schedSub);
  if (!windowStart || (split && !part)) return none;

  if (billedElsewhere(sub, windowStart)) {
    return { billed: true, openDuePaise: 0, receivedPaise: 0, alreadyCreditedPaise: 0, invoiced: false, external: true };
  }

  let invoices: InvoiceRow[] = [];
  if (split) {
    const { data: rows, error } = await supabase
      .from("subscription_billings").select("id, invoice_id")
      .eq("tenant_id", tenantId).eq("subscription_id", sub.id)
      .lte("period_start", today).gt("period_end", today)
      .limit(1);
    if (error) throw new Error("Could not read the billing schedule.");
    const invoiceId = rows?.[0]?.invoice_id;
    if (!invoiceId) return none;
    const { data: inv, error: iErr } = await supabase.from("invoices").select(INVOICE_COLS)
      .eq("tenant_id", tenantId).eq("id", invoiceId).maybeSingle();
    if (iErr) throw new Error("Could not read the part's invoice.");
    if (inv) invoices = [inv as InvoiceRow];
  } else {
    const termEnd = followingTermStart(schedSub);
    const or = [`renewal_subscription_id.eq.${sub.id}`, `add_seats_subscription_id.eq.${sub.id}`];
    if (sub.quote_id) or.push(`id.eq."${sub.quote_id.replace(/["\\]/g, "")}"`);
    const { data: qs, error: qErr } = await supabase.from("quotes").select("id")
      .eq("tenant_id", tenantId).or(or.join(","));
    if (qErr) throw new Error("Could not read the subscription's quotes.");
    const quoteIds = (qs ?? []).map((q) => q.id);
    if (quoteIds.length > 0) {
      let q = supabase.from("invoices").select(INVOICE_COLS)
        .eq("tenant_id", tenantId).in("quote_id", quoteIds).gte("invoice_date", addDaysISO(windowStart, -31));
      if (termEnd) q = q.lt("invoice_date", addDaysISO(termEnd, -31));
      const { data: invs, error: iErr } = await q;
      if (iErr) throw new Error("Could not read the subscription's invoices.");
      invoices = (invs ?? []) as InvoiceRow[];
    }
  }
  invoices = invoices.filter(live);
  if (invoices.length === 0) return none;
  let openDuePaise = 0;
  let receivedPaise = 0;
  for (const inv of invoices) {
    openDuePaise += rupeesToPaise(openInvoiceDue(inv));
    receivedPaise += paidPaise(inv);
  }

  /* Earlier PAID plan changes that cover today: their money is this part's money; what they
     credited is not given again. */
  const { data: changes, error: cErr } = await supabase.from("quotes").select("id, line_items")
    .eq("tenant_id", tenantId).eq("extension_months", 0)
    .contains("line_items", JSON.stringify([{ plan_change: { subscription_id: sub.id } }]));
  if (cErr) throw new Error("Could not read earlier plan changes.");
  const earlier = (changes ?? []).filter((q) => {
    const meta = (Array.isArray(q.line_items) ? (q.line_items[0] as { plan_change?: PlanChangeMeta }) : undefined)?.plan_change;
    return !!meta && meta.period_from >= windowStart && meta.period_to >= today;
  });
  let alreadyCreditedPaise = 0;
  if (earlier.length > 0) {
    const { data: pays, error: pErr } = await supabase.from("payments").select("amount, quote_id")
      .eq("tenant_id", tenantId).in("quote_id", earlier.map((q) => q.id)).eq("status", "received");
    if (pErr) throw new Error("Could not read earlier plan-change payments.");
    const paid = new Set<string>();
    for (const p of pays ?? []) {
      receivedPaise += rupeesToPaise(Math.max(0, p.amount ?? 0));
      if (p.quote_id) paid.add(p.quote_id);
    }
    for (const q of earlier) {
      if (!paid.has(q.id)) continue;
      const meta = (q.line_items as unknown as Array<{ plan_change: PlanChangeMeta }>)[0].plan_change;
      alreadyCreditedPaise += Math.max(0, Math.round(meta.credit_paise ?? 0));
    }
  }

  return { billed: true, openDuePaise, receivedPaise, alreadyCreditedPaise, invoiced: true };
}
