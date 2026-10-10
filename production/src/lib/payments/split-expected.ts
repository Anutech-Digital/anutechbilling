/**
 * R-527 — what the Record payment sheet expects on a split-billed quote.
 *
 * Q-FBB9-27-0020 (annual commitment, billed quarterly, Rs 30,586 quote) asked for
 * "Expected Rs 30,586" — the whole year — while the customer page and the online pay
 * button both collect Rs 7,646 for Q1. Paying that Rs 7,646 then read "Partly paid,
 * Rs 22,940 outstanding". The sheet now expects only the instalments that have fallen
 * due, from the SAME plan as the customer page (lib/billing/instalments.ts:
 * planForQuote + splitDue), with the same rounding as the instalment's tax invoice.
 *
 * Null = not split-billed (yearly, flex, one-off) → the sheet keeps the quote total.
 */
import { planForQuote, splitDue, type SplitQuoteFields, type QuoteInstalmentPlan, type SplitDue } from "@/lib/billing/instalments";
import { cycleScheduleLabel } from "@/lib/quotes/billing";
import type { BillingCycle } from "@/lib/supabase/database.types";

export interface SplitExpectation {
  plan: QuoteInstalmentPlan;
  due: SplitDue;
  /** ₹ the sheet treats as "expected": the instalments due so far (incl GST). */
  expected: number;
  /** "billed quarterly" */
  scheduleLabel: string;
  /** "Instalment 1 of 4" / "Instalments 1–2 of 4" */
  dueLabel: string;
}

export function splitExpectation(args: {
  quote: SplitQuoteFields | null;
  /** The subscription's start date, once one exists; null before the first payment. */
  termStart: string | null;
  todayISO: string;
  alreadyReceived: number;
}): SplitExpectation | null {
  if (!args.quote) return null;
  const plan = planForQuote(args.quote, (args.termStart ?? args.todayISO).slice(0, 10));
  if (!plan) return null;
  const due = splitDue(plan, { todayISO: args.todayISO, received: args.alreadyReceived });
  const first = Math.min(due.paidCount + 1, due.dueCount);
  const dueLabel = due.dueCount <= 1 || first === due.dueCount
    ? `Instalment ${due.dueCount} of ${plan.count}`
    : `Instalments ${first}–${due.dueCount} of ${plan.count}`;
  return {
    plan,
    due,
    expected: due.dueGross,
    scheduleLabel: cycleScheduleLabel(plan.cycle as BillingCycle),
    dueLabel,
  };
}

export interface InstalmentRaiseResult {
  raised: { invoice_id: string; period_index: number; gross: number }[];
  errors: { message: string }[];
}

/**
 * The result toast for a payment on a split-billed quote. The generic toast reads the
 * RPC's quote-level outstanding (quotes.amount − received = the rest of the YEAR), which
 * on Q-FBB9-27-0020 said "Rs 22,940 still pending" the moment Q1 was paid.
 * Pure, so the wording is tested; the dialog only renders it.
 */
export function splitPaymentToast<T extends { tone: "success" | "warning"; title: string; lines: string[] }>(
  base: T,
  args: { split: SplitExpectation; receivedAfter: number; raise: InstalmentRaiseResult | null; formatRupee: (n: number) => string; formatDate: (iso: string) => string },
): T {
  const { split, raise, formatRupee, formatDate } = args;
  /* Which instalment the money now reaches — dates do not matter for that, only order. */
  const due = splitDue(split.plan, { todayISO: split.plan.lines[0].billOn, received: args.receivedAfter });
  const owedNow = Math.max(0, split.expected - args.receivedAfter);
  const lines: string[] = [];
  const issued = raise?.raised ?? [];
  if (issued.length > 0) {
    lines.push(`Tax invoice ${issued.map((r) => r.invoice_id).join(", ")} issued for instalment ${issued.map((r) => r.period_index).join(", ")} of ${split.plan.count}.`);
  }
  if (raise && raise.errors.length > 0) {
    lines.push(`Instalment tax invoice not issued yet: ${raise.errors[0].message} The payment is saved; the daily billing run issues it once this is fixed.`);
  }
  if (owedNow > 0) {
    lines.push(`${formatRupee(owedNow)} of the instalments due so far is still pending.`);
  } else if (due.next) {
    lines.push(`Next instalment ${formatRupee(due.next.gross)} on ${formatDate(due.next.billOn)} (${split.scheduleLabel}).`);
  }
  return {
    ...base,
    tone: raise && raise.errors.length > 0 ? "warning" : base.tone,
    title: owedNow > 0 ? `Instalment payment recorded · ${formatRupee(owedNow)} still due` : "Instalment paid",
    lines: [...lines, ...base.lines.filter((l) => !/outstanding|pending/i.test(l))],
  };
}

/**
 * The one outcome sentence on a split-billed quote. "Quote will be marked fully paid" was
 * wrong there: paying Q1 settles Q1, and the tax invoice is that instalment's, issued as
 * soon as the payment is saved (not "generate the GST invoice from the quote page", which
 * a split-billed quote refuses).
 */
export function splitOutcomeSentence(split: SplitExpectation, args: {
  kind: "none" | "partial" | "full" | "over";
  due: number;
  excess: number;
  formatRupee: (n: number) => string;
  formatDate?: (iso: string) => string;
}): string {
  const r = args.formatRupee;
  const d = args.formatDate ?? ((iso: string) => iso);
  const after = split.plan.lines[split.due.dueCount] ?? null;
  const next = after ? ` Next instalment ${r(after.gross)} on ${d(after.billOn)}.` : "";
  switch (args.kind) {
    case "partial": return `${r(args.due)} of the instalments due now will still be outstanding.`;
    case "over":    return `Instalments due now are paid, with ${r(args.excess)} extra — it is applied to the next instalment's invoice.${next}`;
    case "full":    return `Instalments due now are paid; their tax invoice is issued as soon as the payment is saved.${next}`;
    default:        return "Enter the amount received to see how the instalments end up.";
  }
}
