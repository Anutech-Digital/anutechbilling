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
import { plannedInstalments, instalmentSkip, instalmentsDue, quotePeriodTaxables, type InstalmentSkip, type SplitQuoteFields } from "./instalments";
import { billingTermStart } from "./subscription-schedule";
import { addDaysISO } from "@/lib/dates/ist";
import { billedElsewhere, billedElsewhereLabel } from "@/lib/subscriptions/billed-elsewhere";
import { applyBillOutcome, type BillOutcome } from "./part-requests";
import { partRequestOf } from "./part-request-of.server";
import { partName, type PartInvoice } from "@/lib/invoices/split-sale-pending";
export { partRequestOf };

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
  /** R-1763: imported from Zoho Books — periods starting on/before this day were billed there. */
  external_source?: string | null;
  external_ref?: string | null;
  billed_externally_until?: string | null;
}

export const INSTALMENT_SUB_SELECT =
  "id, tenant_id, quote_id, mrr, billing_cycle, term_months, start_date, renewal_date, external_source, external_ref, billed_externally_until" as const;

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
  /** R-2044: payment requests (quotes) made now for parts that are due but not paid. */
  requests: { period_index: number; quote_id: string; gross: number }[];
  /** R-2044: parts still waiting on a request made earlier (unpaid, or stopped). */
  requestsOpen: { period_index: number; quote_id: string; status: string }[];
  /** R-2044: would have got a payment request (dry run only). */
  wouldRequest: number;
  /** R-2092: parts held back until the quote's other subscriptions have their parts laid. */
  waiting?: { period_index: number; subscription_ids: string[] }[];
  /** R-2095: due parts whose invoice credit notes cancelled in full — not re-billed by this run
   *  (only the owner's own Generate re-bills them: rebillCredited). */
  heldCredited?: { period_index: number; credited: string[] }[];
  /** R-2095 (Sept): due parts that would have got a NEW payment request, left for the billing job
   *  because this run follows a sale's payment (noNewRequests). */
  requestsHeld?: number[];
}

export async function syncSubscriptionInstalments(args: {
  supabase: Admin;
  sub: InstalmentSub;
  quote: QuotePaymentFacts | undefined;
  todayISO: string;
  dryRun?: boolean;
  /** R-2092: lay (insert / re-sync) this subscription's parts and stop — bill nothing. Run for
      every subscription of a quote BEFORE billing any of them, so the quote's parts of one period
      are all there when the first is billed and go on ONE tax invoice (billing_part_group). */
  layOnly?: boolean;
  /** R-2095 (coordinator, 30 Oct): a part freed by credit notes for its whole invoice is billed
   *  again ONLY when the owner asks (Invoices → Generate invoice for Qn, Renewals → Generate). A
   *  credit note often means "customer cancelled / we don't bill this" — the billing job and the
   *  auto-raise after a payment leave it alone. */
  rebillCredited?: boolean;
  /** R-2095 (Sept reconcile): the run right after a sale's payment — invoice what the money covers,
   *  never make a next-period payment request (that is the billing job's, on the part's own date). */
  noNewRequests?: boolean;
}): Promise<InstalmentSyncResult> {
  const { supabase, sub, quote, todayISO } = args;
  const dryRun = args.dryRun ?? false;
  const out: InstalmentSyncResult = emptySyncResult();

  /* R-1763: a period Zoho already billed is never laid or invoiced here (the database refuses
     it too — trigger subscription_billings_not_billed_elsewhere). The term key stays the
     whole term's first day, so the periods still to bill here keep their usual key. */
  /* R-2104: the quote's only split-billed subscription is laid with the QUOTE's period amounts —
     the figure the Record payment sheet asked (quotePeriodTaxables). */
  const mrrTerm = plannedInstalments(sub);
  const wholeTerm = mrrTerm.length > 0
    ? quotePeriodTaxables(mrrTerm, { mrr: sub.mrr, cycle: sub.billing_cycle, ...(await quotePlanFacts(supabase, sub)) })
    : mrrTerm;
  const planned = wholeTerm.filter((p) => !billedElsewhere(sub, p.periodStart));
  if (wholeTerm.length > 0 && planned.length === 0) {
    out.skip = { code: "billed_elsewhere", reason: `${billedElsewhereLabel(sub)} — this term is not invoiced again here; the next term is.` };
    return out;
  }
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
  if (args.layOnly) return out;

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

  /* R-2044: a part whose date came is invoiced only when it is paid (R-2048: the sale quote's
     first part too — only once the sale quote's money covers it; until then the open sale quote
     is its request), a term paid up front, or its own payment request paid — otherwise it gets a payment
     request. bill_subscription_instalment decides, in one transaction, and invoices through
     raise_subscription_billing (the one instalment invoice path). */
  /* R-2095: which due parts were freed by a full credit note (credited_invoice_ids, migration
     20261030035007 — not in the generated types yet, so read untyped). */
  const creditedOf = new Map<string, string[]>();
  if (due.length > 0) {
    const { data: cr, error: crErr } = await (supabase as unknown as SupabaseClient)
      .from("subscription_billings").select("id, credited_invoice_ids").in("id", due.map((r) => r.id));
    if (crErr) throw new Error(crErr.message);
    for (const c of (cr ?? []) as Array<{ id: string; credited_invoice_ids: string[] | null }>) {
      creditedOf.set(c.id, (c.credited_invoice_ids ?? []).filter(Boolean));
    }
  }
  for (const row of due) {
    /* R-2095: a credited part waits for the owner's own Generate. */
    const credited = creditedOf.get(row.id) ?? [];
    if (credited.length > 0 && !args.rebillCredited) {
      (out.heldCredited ??= []).push({ period_index: row.period_index, credited });
      continue;
    }
    if (args.noNewRequests && !dryRun) {
      /* R-2095: look first (dry run) — a part that would get a NEW request is left for its own run. */
      const { data: peek, error: pErr } = await billSubscriptionInstalment(supabase, row.id, true);
      if (pErr) throw new Error(pErr.message);
      if ((peek as { action?: string } | null)?.action === "request") {
        (out.requestsHeld ??= []).push(row.period_index);
        continue;
      }
    }
    const { data, error } = await billSubscriptionInstalment(supabase, row.id, dryRun);
    if (error) throw new Error(error.message);
    applyBillOutcome(out, row.period_index, data, dryRun);
  }

  /* R-527: OWED follows the instalments that have fallen due, not the year. */
  if (!dryRun) {
    const { error } = await syncSplitOutstanding(supabase, sub.id);
    if (error) throw new Error(error.message);
  }
  return out;
}

/**
 * R-2104: what quotePeriodTaxables needs from the subscription's quote — its split fields and how
 * many split-billed subscriptions it has (active ones + this one). No quote, or a failed read → { quote: null }:
 * the MRR figures stand (as before R-2104).
 */
export async function quotePlanFacts(
  supabase: Admin,
  sub: Pick<InstalmentSub, "id" | "tenant_id" | "quote_id" | "billing_cycle">,
): Promise<{ quote: SplitQuoteFields | null; splitSubsOfQuote: number }> {
  const quoteId = sub.quote_id;
  if (!quoteId || !sub.billing_cycle || sub.billing_cycle === "yearly") return { quote: null, splitSubsOfQuote: 0 };
  const read = await (async () => Promise.all([
    supabase.from("quotes")
      .select("subtotal, discount_pct, tax_rate, amount, billing_cycle, line_items")
      .eq("tenant_id", sub.tenant_id).eq("id", quoteId).maybeSingle(),
    supabase.from("subscriptions")
      .select("id, billing_cycle, status")
      .eq("tenant_id", sub.tenant_id).eq("quote_id", quoteId),
  ]))().catch(() => null);
  if (!read) return { quote: null, splitSubsOfQuote: 0 };
  const [{ data: q, error: qErr }, { data: subs, error: sErr }] = read;
  if (qErr || sErr || !q) return { quote: null, splitSubsOfQuote: 0 };
  return {
    quote: q as SplitQuoteFields,
    splitSubsOfQuote: (subs ?? []).filter((x) => (x.id === sub.id || x.status === "active") && x.billing_cycle != null && x.billing_cycle !== "yearly").length,
  };
}

export function emptySyncResult(): InstalmentSyncResult {
  return {
    skip: null, created: 0, resynced: 0, raised: [], alreadyRaised: 0, wouldRaise: 0,
    requests: [], requestsOpen: [], wouldRequest: 0,
  };
}

/**
 * public.bill_subscription_instalment (R-2044, migration 20261028025317): invoice a paid part, or
 * make (once) the payment request of an unpaid one. Untyped call, shapes pinned in
 * part-requests.ts (BillOutcome), like sync_split_outstanding below.
 */
export function billSubscriptionInstalment(supabase: Admin, billingId: string, dryRun: boolean): PromiseLike<{ data: unknown; error: { message: string } | null }> {
  return (supabase as unknown as SupabaseClient).rpc("bill_subscription_instalment", { p_billing_id: billingId, p_dry_run: dryRun });
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
  /** R-2057: every due part of the quote that HAS its tax invoice — raised now or before — so the
      Invoices page's Generate opens the one that exists instead of failing or making another. */
  invoices: PartInvoice[];
}

/**
 * R-2057: the due parts (bill_on ≤ today) of these subscriptions that have their tax invoice, in
 * period order. `onlyBillingId` narrows it to one part (a part's own payment request).
 */
export async function duePartInvoices(
  supabase: Admin,
  args: { subscriptionIds: string[]; todayISO: string; raisedNow: ReadonlySet<string>; onlyBillingId?: string | null },
): Promise<PartInvoice[]> {
  if (args.subscriptionIds.length === 0) return [];
  let q = supabase
    .from("subscription_billings")
    .select("id, subscription_id, period_index, period_start, period_end, bill_on, invoice_id")
    .in("subscription_id", args.subscriptionIds)
    .not("invoice_id", "is", null)
    .lte("bill_on", args.todayISO);
  if (args.onlyBillingId) q = q.eq("id", args.onlyBillingId);
  const { data: rows, error } = await q;
  if (error) throw new Error(error.message);
  if (!rows || rows.length === 0) return [];
  const [{ data: subs }, { data: invs }] = await Promise.all([
    supabase.from("subscriptions").select("id, billing_cycle").in("id", [...new Set(rows.map((r) => r.subscription_id))]),
    supabase.from("invoices").select("id, amount").in("id", rows.map((r) => r.invoice_id as string)),
  ]);
  const cycleOf = new Map((subs ?? []).map((x) => [x.id, (x.billing_cycle ?? null) as string | null]));
  const amountOf = new Map((invs ?? []).map((x) => [x.id, x.amount ?? 0]));
  /* R-2092: the parts of one quote period share ONE invoice — report it once. */
  const seen = new Set<string>();
  return [...rows]
    .sort((a, b) => a.period_start.localeCompare(b.period_start) || a.period_index - b.period_index)
    .filter((r) => {
      const id = r.invoice_id as string;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((r) => ({
      subscription_id: r.subscription_id,
      period_index:    r.period_index,
      part:            partName(cycleOf.get(r.subscription_id) ?? null, r.period_index),
      invoice_id:      r.invoice_id as string,
      gross:           amountOf.get(r.invoice_id as string) ?? 0,
      period_start:    r.period_start,
      period_end:      r.period_end,
      raised_now:      args.raisedNow.has(r.invoice_id as string),
    }));
}

/**
 * R-2092: lay (insert / re-sync, no billing) the parts of every subscription in `subs`. A failure
 * is RETURNED per subscription and logged — never swallowed (68ed55d70 swallowed it, and on
 * localhost the quote's Q1 went out as the Starter alone). Billing stays safe without it: the
 * database bills no part while another subscription of its quote has no parts laid
 * (bill_subscription_instalment → 'waiting', migration 20261029052411).
 * Returns the parts laid / re-synced, for the cron's counts. A dry run writes nothing.
 */
export async function layInstalments(
  supabase: Admin,
  subs: InstalmentSub[],
  quoteOf: (sub: InstalmentSub) => QuotePaymentFacts | undefined,
  todayISO: string,
  dryRun: boolean,
): Promise<{ created: number; resynced: number; errors: { subscription_id: string; message: string }[] }> {
  const out = { created: 0, resynced: 0, errors: [] as { subscription_id: string; message: string }[] };
  if (dryRun) return out;
  for (const sub of subs) {
    try {
      const r = await syncSubscriptionInstalments({ supabase, sub, quote: quoteOf(sub), todayISO, layOnly: true });
      out.created += r.created;
      out.resynced += r.resynced;
    } catch (e) {
      const message = `Laying the parts failed: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[billing/lay] subscription ${sub.id}: ${message}`);
      out.errors.push({ subscription_id: sub.id, message });
    }
  }
  return out;
}

/** R-2092: the subscriptions in `subs` that share their quote with another one in `subs`. */
export function quoteSiblings<T extends Pick<InstalmentSub, "tenant_id" | "quote_id">>(subs: T[]): T[] {
  const key = (s: T) => `${s.tenant_id}:${s.quote_id}`;
  const count = new Map<string, number>();
  for (const s of subs) if (s.quote_id) count.set(key(s), (count.get(key(s)) ?? 0) + 1);
  return subs.filter((s) => s.quote_id != null && (count.get(key(s)) ?? 0) > 1);
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
  /** R-2095: the owner's own Generate — re-bill parts freed by a full credit note. */
  rebillCredited?: boolean;
  /** R-2095 (Sept): right after a sale's payment — no next-period payment request. */
  noNewRequests?: boolean;
}): Promise<QuoteInstalmentOutcome> {
  const { supabase, quoteId, tenantId, todayISO } = args;
  const out: QuoteInstalmentOutcome = { raised: [], errors: [], splitBilled: false, invoices: [] };
  /* R-2057: which of the reported invoices THIS call raised. `raised` keeps its meaning for the
     Record payment toast (a part request's invoice raised by the payment trigger is in it). */
  const raisedNow = new Set<string>();
  const withInvoices = async (subscriptionIds: string[], onlyBillingId?: string) => {
    try {
      out.invoices = await duePartInvoices(supabase, { subscriptionIds, todayISO, onlyBillingId, raisedNow });
    } catch (e) {
      out.errors.push({ subscription_id: subscriptionIds[0] ?? "", message: e instanceof Error ? e.message : String(e) });
    }
  };

  /* R-2044: the paid quote is ONE part's payment request → that part's tax invoice. Paying it
     already raised it in the same transaction (tg_payments_part_request_invoice); this reports
     it, or raises it now if that step was refused then (e.g. the customer had no state). */
  const part = await partRequestOf(supabase, quoteId, tenantId);
  if (part) {
    out.splitBilled = true;
    try {
      const { data, error: bErr } = await billSubscriptionInstalment(supabase, part.billingId, false);
      if (bErr) throw new Error(bErr.message);
      const r = data as BillOutcome;
      const invoiceId = r.action === "invoice" || r.action === "already_invoiced" ? r.invoice_id ?? null : null;
      if (invoiceId && r.action === "invoice" && !r.already_raised) raisedNow.add(invoiceId);
      if (invoiceId) {
        const { data: inv } = await supabase.from("invoices").select("amount").eq("id", invoiceId).maybeSingle();
        out.raised.push({ subscription_id: part.subscriptionId, period_index: part.periodIndex, invoice_id: invoiceId, gross: inv?.amount ?? 0 });
      }
    } catch (e) {
      out.errors.push({ subscription_id: part.subscriptionId, message: e instanceof Error ? e.message : String(e) });
    }
    await withInvoices([part.subscriptionId], part.billingId);
    return out;
  }
  const { data: subs, error } = await supabase
    .from("subscriptions")
    .select(INSTALMENT_SUB_SELECT)
    .eq("tenant_id", tenantId)
    .eq("quote_id", quoteId)
    .eq("status", "active");
  if (error) { out.errors.push({ subscription_id: "", message: error.message }); return out; }
  if (!subs || subs.length === 0) return out;

  const facts = await readQuotePaymentFacts(supabase, quoteId);
  /* R-2092: every subscription's parts are laid first, then billed — a quote's parts for one
     period become ONE tax invoice only when they all exist at the first bill. */
  if (subs.length > 1) {
    const laid = await layInstalments(supabase, subs, () => facts, todayISO, false);
    out.errors.push(...laid.errors);
  }
  for (const sub of subs) {
    try {
      const r = await syncSubscriptionInstalments({ supabase, sub, quote: facts, todayISO, rebillCredited: args.rebillCredited, noNewRequests: args.noNewRequests });
      if (r.skip?.code === "not_split_billed") continue;
      out.splitBilled = true;
      for (const x of r.raised) { out.raised.push({ subscription_id: sub.id, ...x }); raisedNow.add(x.invoice_id); }
    } catch (e) {
      out.splitBilled = true;
      out.errors.push({ subscription_id: sub.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  if (out.splitBilled) await withInvoices(subs.filter((x) => x.billing_cycle !== "yearly").map((x) => x.id));
  return out;
}

