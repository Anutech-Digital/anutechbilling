/**
 * R-2758 (R-2739a, 14 Nov 2026): what the Renewals page hands renewalStage() (lib/renewals/stage.ts,
 * R-2738) for one row — built from what the page already reads, no new query.
 *
 * R-2738 follow-ups this answers:
 *   - "compute the stage only once last-docs is loaded — never paint a partial stage" (userAudit14Nov:
 *     the chip flipped Due → Renewal quote sent a second after load): stageInputFor() returns null
 *     while the documents read is still loading; the row shows a placeholder, not a guess.
 *   - "pass only the current renewal's doc": the open document is the renewal's (docs.sent is the
 *     linked renewal quote or the newest term's part proforma); the invoice is the one raised from
 *     the renewal quote or for a part of the next term — an older term's unpaid invoice is the
 *     "previous term unpaid" flag, never the row's stage.
 *   - "amountDue below half a paisa shows ₹0 due": the amount is rounded to paise first; under
 *     ₹0.005 (float dust) counts as paid.
 * Pure — tested in stage-input-r2758.test.ts.
 */
import { followingTermStart } from "@/lib/billing/subscription-schedule";
import { isSplitBilled } from "@/lib/billing/instalments";
import { fullyCredited, invoicePaymentState } from "@/lib/invoices/payment-state";
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import type { BillingCycle } from "@/lib/supabase/database.types";
import type { StageDoc, StageFlagInput, StageInput, StageInvoice, StageSub } from "@/lib/renewals/stage";
import type { LastDocs, LastInvoice } from "./last-docs";

export interface StageRowSub extends StageSub {
  id: string;
}

export interface StageRowFacts {
  sub: StageRowSub;
  todayIst: string;
  /** The row's documents (last-docs-data.ts); undefined = none read for it. */
  docs: LastDocs | undefined;
  /** The documents read is still loading → no stage yet (null). */
  docsLoading: boolean;
  /** The linked renewal quote's status from the open renewal quotes (draft / sent / …), when read. */
  linkedStatus?: string | null;
  /** The linked renewal quote's own row (quote info), when read. */
  linkedQuote?: { status?: string | null; payment_status?: string | null } | null;
  /** The renewal is paid (isPaidRenewalQuote). */
  renewalPaid: boolean;
  flags?: StageFlagInput;
}

const VOID = new Set(["void", "cancelled"]);

/** Money still to collect on an invoice, in paise-rounded rupees; settled / void / credited = 0. */
export function invoiceOwed(i: LastInvoice): number {
  const facts = {
    status: i.status, amount: i.amount, net_payable: i.netPayable, paid_amount: i.paidAmount,
    adjusted_advances: i.adjustedAdvances, written_off_at: i.writtenOffAt,
    credit_noted: i.notes === undefined ? undefined : i.notes?.credit ?? 0,
    debit_noted: i.notes?.debit ?? 0,
  };
  if (VOID.has((i.status ?? "").toLowerCase())) return 0;
  if (i.notes && fullyCredited(facts)) return 0;
  const state = invoicePaymentState(facts);
  if (state !== "unpaid" && state !== "partial") return 0;
  const due = invoiceAmountDue({
    status: i.status, due_date: i.dueDate, amount: i.amount, net_payable: i.netPayable,
    paid_amount: i.paidAmount, written_off_at: i.writtenOffAt, adjusted_advances: i.adjustedAdvances,
  });
  /* rev-r2738 SAFE note: float dust (0.004) is not "₹0 due" + Record payment. */
  const paise = Math.round(due * 100) / 100;
  return paise >= 0.01 ? paise : 0;
}

/** The first day of the term being renewed (the next term) — a part on/after it belongs to the renewal. */
export function renewalTermStart(sub: StageSub): string | null {
  if (!sub.renewal_date) return null;
  return followingTermStart({ term_months: sub.term_months ?? 12, start_date: sub.start_date ?? null, renewal_date: sub.renewal_date });
}

/** The renewal's own invoice with money due: raised from the linked renewal quote, or for a part of the next term. */
export function renewalInvoice(sub: StageRowSub, docs: LastDocs | undefined): { invoice: LastInvoice; owed: number } | null {
  if (!docs) return null;
  const list = docs.invoices.length ? docs.invoices : docs.invoice ? [docs.invoice] : [];
  const start = renewalTermStart(sub);
  const split = isSplitBilled((sub.billing_cycle ?? null) as BillingCycle | null);
  for (const i of list) {
    const ofRenewalQuote = !!sub.renewal_quote_id && i.sourceQuoteId === sub.renewal_quote_id;
    const ofNextPart = split && !!start && !!i.part?.start && i.part.start >= start;
    if (!ofRenewalQuote && !ofNextPart) continue;
    const owed = invoiceOwed(i);
    if (owed > 0) return { invoice: i, owed };
  }
  return null;
}

/** The renewal's open document: the sent renewal quote / part proforma, else the linked renewal quote when its status is read. */
export function renewalDoc(f: Pick<StageRowFacts, "sub" | "docs" | "linkedStatus" | "linkedQuote">): StageDoc | null {
  const sent = f.docs?.sent ?? null;
  if (sent) {
    const q = f.docs?.quote && f.docs.quote.id === sent.quoteId ? f.docs.quote : null;
    return {
      kind: sent.kind, quoteId: sent.quoteId, status: sent.status, paymentStatus: q?.payment_status ?? null,
      dueDate: sent.dueDate ?? null, period: q?.period ?? null,
    };
  }
  const id = f.sub.renewal_quote_id;
  const status = f.linkedStatus ?? f.linkedQuote?.status ?? null;
  if (!id || !status) return null;   // not read → renewalStage counts a linked quote as sent (R-2232)
  return { kind: "renewal", quoteId: id, status, paymentStatus: f.linkedQuote?.payment_status ?? null };
}

/** The StageInput for one row, or null while its documents are still loading (no partial chip). */
export function stageInputFor(f: StageRowFacts): StageInput | null {
  if (f.docsLoading) return null;
  const inv = renewalInvoice(f.sub, f.docs);
  const invoice: StageInvoice | null = inv
    ? {
      id: inv.invoice.id, kind: inv.invoice.part ? "part" : "renewal", amountDue: inv.owed,
      currency: inv.invoice.currency, dueDate: inv.invoice.part?.start ?? null, period: inv.invoice.period,
    }
    : null;
  return { sub: f.sub, todayIst: f.todayIst, renewalPaid: f.renewalPaid, doc: renewalDoc(f), invoice, flags: f.flags };
}

/** Record payment's target: the open quote's own dialog (?pay=1), else the invoice's source quote, else the invoice page. */
export function payHref(stage: { quoteId: string | null; invoiceId: string | null }, docs: LastDocs | undefined): string | null {
  if (stage.quoteId) return `/quotes/${encodeURIComponent(stage.quoteId)}?pay=1`;
  if (!stage.invoiceId) return null;
  const list = docs ? (docs.invoices.length ? docs.invoices : docs.invoice ? [docs.invoice] : []) : [];
  const src = list.find((i) => i.id === stage.invoiceId)?.sourceQuoteId;
  return src ? `/quotes/${encodeURIComponent(src)}?pay=1` : `/invoices/${encodeURIComponent(stage.invoiceId)}`;
}
