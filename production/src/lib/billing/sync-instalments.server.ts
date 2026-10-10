/**
 * Materialise a split-billed subscription's instalments and raise every one that is due.
 *
 * The body of the daily billing cron (app/api/cron/billing), moved here unchanged so the
 * SAME code also runs the moment a payment is recorded (R-527). Before that, a customer who
 * paid Q1 of a quarterly year had no tax invoice until the next cron run — on 9 Oct 2026
 * Q-FBB9-27-0020 showed 0 invoices and 0 schedule rows after its Rs 7,646 payment.
 *
 * Every write is idempotent: instalments are keyed (subscription_id, term_start,
 * period_index) and raise_subscription_billing returns the existing invoice for a period
 * already billed. Running it from the payment AND from the cron is therefore safe.
 * Already-invoiced rows are frozen; unbilled rows re-sync to the current MRR.
 *
 * Server-only — inserts into subscription_billings need the service role.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { plannedInstalments, instalmentSkip, instalmentsDue, type InstalmentSkip } from "./instalments";
import { billingTermStart } from "./subscription-schedule";
import { addDaysISO } from "@/lib/dates/ist";

type Admin = SupabaseClient<Database>;

export interface InstalmentSub {
  id: string;
  tenant_id: string;
  quote_id: string | null;
  mrr: number;
  billing_cycle: Database["public"]["Tables"]["subscriptions"]["Row"]["billing_cycle"];
  term_months: Database["public"]["Tables"]["subscriptions"]["Row"]["term_months"];
  start_date: string | null;
  renewal_date: string | null;
}

export const INSTALMENT_SUB_SELECT =
  "id, tenant_id, quote_id, mrr, billing_cycle, term_months, start_date, renewal_date" as const;

export interface QuotePaymentFacts {
  amount: number | null;
  payment_amount: number | null;
  /** The quote already has a whole-term tax invoice. */
  invoiced: boolean;
}

export interface InstalmentSyncResult {
  skip: InstalmentSkip | null;
  created: number;
  resynced: number;
  raised: { period_index: number; invoice_id: string; gross: number }[];
  alreadyRaised: number;
  /** Would have been raised (dry run only). */
  wouldRaise: number;
}

export async function syncSubscriptionInstalments(args: {
  supabase: Admin;
  sub: InstalmentSub;
  quote: QuotePaymentFacts | undefined;
  todayISO: string;
  dryRun?: boolean;
}): Promise<InstalmentSyncResult> {
  const { supabase, sub, quote, todayISO } = args;
  const dryRun = args.dryRun ?? false;
  const out: InstalmentSyncResult = { skip: null, created: 0, resynced: 0, raised: [], alreadyRaised: 0, wouldRaise: 0 };

  const planned = plannedInstalments(sub);
  const skip = instalmentSkip({
    cycle:         sub.billing_cycle,
    quotePaid:     quote?.payment_amount,
    quoteAmount:   quote?.amount,
    quoteInvoiced: quote?.invoiced ?? false,
    scheduleSize:  planned.length,
  });
  if (skip) { out.skip = skip; return out; }

  /* R-451: the corrected term start can be one day earlier than the key this term's
     instalments were already filed under — keep that key, or they are made twice. */
  const correctedStart = planned[0].termStart;
  const { data: termRows, error: tsErr } = await supabase
    .from("subscription_billings")
    .select("term_start")
    .eq("subscription_id", sub.id)
    .in("term_start", [correctedStart, addDaysISO(correctedStart, 1)]);
  if (tsErr) throw new Error(tsErr.message);
  const termStart = billingTermStart(correctedStart, (termRows ?? []).map((r) => r.term_start));
  if (termStart !== correctedStart) {
    for (const p of planned) p.termStart = termStart;
  }

  const { data: existing, error: exErr } = await supabase
    .from("subscription_billings")
    .select("id, period_index, taxable_amount, invoice_id, bill_on")
    .eq("subscription_id", sub.id)
    .eq("term_start", termStart);
  if (exErr) throw new Error(exErr.message);

  const byIndex = new Map((existing ?? []).map((r) => [r.period_index, r]));

  const toInsert = planned
    .filter((p) => !byIndex.has(p.periodIndex))
    .map((p) => ({
      tenant_id:       sub.tenant_id,
      subscription_id: sub.id,
      term_start:      p.termStart,
      period_index:    p.periodIndex,
      bill_on:         p.billOn,
      period_start:    p.periodStart,
      period_end:      p.periodEnd,
      taxable_amount:  p.taxableAmount,
    }));

  /* Only rows with no invoice — an instalment already invoiced is a GST document's source. */
  const toResync = planned.filter((p) => {
    const row = byIndex.get(p.periodIndex);
    return row != null && row.invoice_id == null && row.taxable_amount !== p.taxableAmount;
  });

  if (!dryRun) {
    if (toInsert.length > 0) {
      const { error } = await supabase.from("subscription_billings").insert(toInsert);
      if (error) throw new Error(error.message);
    }
    for (const p of toResync) {
      const row = byIndex.get(p.periodIndex)!;
      const { error } = await supabase
        .from("subscription_billings")
        .update({ taxable_amount: p.taxableAmount, bill_on: p.billOn, updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .is("invoice_id", null);   // re-checked at write time, not just at read time
      if (error) throw new Error(error.message);
    }
  }
  out.created  = toInsert.length;
  out.resynced = toResync.length;

  const { data: fresh, error: frErr } = dryRun
    ? { data: existing ?? [], error: null }
    : await supabase
        .from("subscription_billings")
        .select("id, period_index, bill_on, invoice_id")
        .eq("subscription_id", sub.id)
        .eq("term_start", termStart);
  if (frErr) throw new Error(frErr.message);

  const due = instalmentsDue(
    (fresh ?? []).map((r) => ({ ...r, billOn: r.bill_on, invoiceId: r.invoice_id })),
    todayISO,
  );

  for (const row of due) {
    if (dryRun) { out.wouldRaise += 1; continue; }
    const { data, error } = await supabase.rpc("raise_subscription_billing", { p_billing_id: row.id });
    if (error) throw new Error(error.message);
    const r = data?.[0];
    if (!r) throw new Error(`raise_subscription_billing returned nothing for instalment ${row.id}`);
    if (r.already_raised) out.alreadyRaised += 1;
    else out.raised.push({ period_index: row.period_index, invoice_id: r.invoice_id, gross: r.gross });
  }

  /* R-527: OWED follows the instalments that have fallen due, not the year. */
  if (!dryRun) {
    const { error } = await syncSplitOutstanding(supabase, sub.id);
    if (error) throw new Error(error.message);
  }
  return out;
}

/**
 * public.sync_split_outstanding (migration 20261009235800). Called through the untyped client
 * because database.generated.ts is regenerated from the live schema after the migration is
 * deployed — the argument and result shapes are pinned here instead.
 */
function syncSplitOutstanding(supabase: Admin, subscriptionId: string): PromiseLike<{ data: number | null; error: { message: string } | null }> {
  return (supabase as unknown as SupabaseClient).rpc("sync_split_outstanding", { p_subscription_id: subscriptionId });
}

/** The quote facts instalmentSkip() needs, for one quote. */
export async function readQuotePaymentFacts(supabase: Admin, quoteId: string): Promise<QuotePaymentFacts | undefined> {
  const [{ data: q }, { data: whole }] = await Promise.all([
    supabase.from("quotes").select("amount, payment_amount, invoice_id").eq("id", quoteId).maybeSingle(),
    supabase.from("invoices").select("id").eq("quote_id", quoteId).neq("status", "void").limit(1),
  ]);
  if (!q) return undefined;
  return { amount: q.amount, payment_amount: q.payment_amount, invoiced: q.invoice_id != null || (whole ?? []).length > 0 };
}

export interface QuoteInstalmentOutcome {
  /** Invoices raised now, across the quote's subscriptions. */
  raised: { subscription_id: string; period_index: number; invoice_id: string; gross: number }[];
  /** Why a subscription could not be invoiced (no state on the customer, …) — said, never swallowed. */
  errors: { subscription_id: string; message: string }[];
  /** True when the quote has at least one split-billed subscription. */
  splitBilled: boolean;
}

/**
 * Right after a payment on a quote: raise every due instalment of that quote's
 * subscriptions. A quote that is not split-billed returns splitBilled:false and writes
 * nothing. Errors are returned per subscription, not thrown — the payment is already
 * recorded and must stay recorded; the daily cron retries.
 */
export async function raiseDueInstalmentsForQuote(args: {
  supabase: Admin;
  quoteId: string;
  tenantId: string;
  todayISO: string;
}): Promise<QuoteInstalmentOutcome> {
  const { supabase, quoteId, tenantId, todayISO } = args;
  const out: QuoteInstalmentOutcome = { raised: [], errors: [], splitBilled: false };
  const { data: subs, error } = await supabase
    .from("subscriptions")
    .select(INSTALMENT_SUB_SELECT)
    .eq("tenant_id", tenantId)
    .eq("quote_id", quoteId)
    .eq("status", "active");
  if (error) { out.errors.push({ subscription_id: "", message: error.message }); return out; }
  if (!subs || subs.length === 0) return out;

  const facts = await readQuotePaymentFacts(supabase, quoteId);
  for (const sub of subs) {
    try {
      const r = await syncSubscriptionInstalments({ supabase, sub, quote: facts, todayISO });
      if (r.skip?.code === "not_split_billed") continue;
      out.splitBilled = true;
      for (const x of r.raised) out.raised.push({ subscription_id: sub.id, ...x });
    } catch (e) {
      out.splitBilled = true;
      out.errors.push({ subscription_id: sub.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
