/**
 * R-530 — late payment charges: HOW MUCH, for one overdue invoice. Pure; no I/O.
 *
 * Pardeep (9 Oct 2026): Rs 500 once after the due date, plus interest = outstanding × 18% ×
 * days / 365, in IST days, on the balance still owed each day (so a part payment lowers it
 * from the next day). Interest only for GST-registered customers (7 Oct rule); an
 * unregistered customer gets the flat fee only. Both figures come from the company setting.
 *
 * Rules, all customer-favourable where the data is unsure:
 *   - Grace: the first `graceDays` days after the due date carry no charge at all; the fee and
 *     interest start on day graceDays + 1.
 *   - Charges count only from the day late fees were switched on at the winning level
 *     (`since`). Switching it on today does not bill a year of history nobody was told about.
 *   - The interest arithmetic is lib/credit/late-interest.ts (R-368) — the same day rule and
 *     single rounding the credit quotes already use. Not a second copy.
 *   - Principal = the invoice's balance base (net_payable, i.e. after credit notes/advances)
 *     WITHOUT earlier late-charge debit notes, so interest never runs on interest or on the fee.
 *   - Receipts: the quote's received payments, minus advances already adjusted at issue, taken
 *     oldest first up to the invoice's paid amount. Anything paid that cannot be dated is
 *     treated as paid on the due date (no interest on it) rather than guessed late.
 *   - Billed amounts are cumulative: what was already put on a late-charge debit note (and
 *     R-368's interest notes) is subtracted, so a second click bills only what is new.
 *   - GST: at the invoice's own rate. No rate on the invoice → null, and billing is refused.
 */
import { addDaysISO } from "@/lib/dates/ist";
import { lateInterest, interestAlreadyCharged, type DatedPayment, type InterestNoteRow } from "@/lib/credit/late-interest";
import type { EffectiveLateFee, LateFeeSettings } from "./rules";

export interface LateChargeInvoice {
  id: string;
  status: string;
  due_date: string | null;
  amount: number;
  net_payable: number | null;
  paid_amount: number | null;
  /** GST % the invoice was issued at. Null = unknown; never assumed. */
  tax_rate: number | null;
  /** Payment ids already adjusted onto the invoice at issue (adjusted_advances[].payment_id). */
  adjustedPaymentIds?: readonly string[];
}

export interface QuotePayment {
  id?: string | null;
  amount: number;
  /** IST date, YYYY-MM-DD. */
  date: string;
}

export interface LateChargeBillRow {
  fee_amount: number;
  interest_amount: number;
  gross_amount: number;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CHARGEABLE = new Set(["pending", "overdue", "paid"]);

/** Receipts that paid THIS invoice, dated, oldest first. See the header for the rules. */
export function invoicePaymentTimeline(input: {
  payments: readonly QuotePayment[];
  adjustedPaymentIds?: readonly string[];
  paidAmount: number;
  principal: number;
  status: string;
  dueDate: string;
}): DatedPayment[] {
  const principal = Math.max(0, Math.round(input.principal));
  const paidRaw = Math.max(0, Math.round(input.paidAmount || 0));
  const target = Math.min(principal, input.status === "paid" ? Math.max(paidRaw, principal) : paidRaw);
  const skip = new Set(input.adjustedPaymentIds ?? []);
  const usable = input.payments
    .filter((p) => !(p.id && skip.has(p.id)))
    .filter((p) => Number.isFinite(p.amount) && p.amount > 0 && ISO_DAY.test((p.date ?? "").slice(0, 10)))
    .map((p) => ({ amount: Math.round(p.amount), date: p.date.slice(0, 10) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out: DatedPayment[] = [];
  let left = target;
  for (const p of usable) {
    if (left <= 0) break;
    const take = Math.min(left, p.amount);
    out.push({ amount: take, date: p.date });
    left -= take;
  }
  if (left > 0) out.push({ amount: left, date: input.dueDate.slice(0, 10) });
  return out;
}

export interface LateChargeView {
  /** False = nothing is or will be charged (off, waived, not late, settled on time …). */
  applies: boolean;
  reason: string;
  /** Last day without any charge: due date + grace (or the day before `since`). */
  lastFreeDay: string | null;
  /** Late days (after grace / since) on which money was owed. */
  daysLate: number;
  /** ₹ owed at the end of today (principal only). */
  outstanding: number;
  interestPct: number;
  /** False for an unregistered customer when the company charges interest to registered only. */
  interestApplies: boolean;
  feeAccrued: number;
  interestAccrued: number;
  feeBilled: number;
  interestBilled: number;
  feeToBill: number;
  interestToBill: number;
  /** feeToBill + interestToBill (taxable value of the next debit note). */
  toBill: number;
  taxRate: number | null;
  /** GST on `toBill` at the invoice's rate; null when the invoice has no rate. */
  gstToBill: number | null;
  grossToBill: number | null;
  /** Interest window for the record: first chargeable day → today. */
  interestFrom: string | null;
  interestTo: string | null;
}

export function computeLateCharges(input: {
  settings: LateFeeSettings;
  effective: EffectiveLateFee;
  registered: boolean;
  invoice: LateChargeInvoice;
  payments: readonly QuotePayment[];
  bills: readonly LateChargeBillRow[];
  /** All debit notes on the invoice (R-368 interest notes are recognised by their prefix). */
  debitNotes?: readonly InterestNoteRow[];
  today: string;
}): LateChargeView {
  const { settings, effective, invoice, today } = input;
  const feeBilled = input.bills.reduce((s, b) => s + Math.max(0, b.fee_amount), 0);
  const r368 = interestAlreadyCharged(input.debitNotes ?? []);
  const interestBilled = input.bills.reduce((s, b) => s + Math.max(0, b.interest_amount), 0) + r368.taxable;
  const billedGross = input.bills.reduce((s, b) => s + Math.max(0, b.gross_amount), 0) + r368.gross;
  const interestApplies = !settings.interestRegisteredOnly || input.registered;
  const base: LateChargeView = {
    applies: false, reason: "", lastFreeDay: null, daysLate: 0, outstanding: 0,
    interestPct: settings.interestPct, interestApplies,
    feeAccrued: 0, interestAccrued: 0, feeBilled, interestBilled,
    feeToBill: 0, interestToBill: 0, toBill: 0,
    taxRate: invoice.tax_rate, gstToBill: invoice.tax_rate === null ? null : 0, grossToBill: invoice.tax_rate === null ? null : 0,
    interestFrom: null, interestTo: null,
  };

  const due = (invoice.due_date ?? "").slice(0, 10);
  if (!CHARGEABLE.has(invoice.status)) return { ...base, reason: `Invoice is ${invoice.status}.` };
  if (!ISO_DAY.test(due)) return { ...base, reason: "No due date on this invoice, so it cannot be late." };
  if (effective.waived) return { ...base, reason: `Waived by the owner${effective.waiveReason ? `: ${effective.waiveReason}` : ""}.` };
  if (!effective.on) return { ...base, reason: "Late charges are off for this invoice." };

  const principal = Math.max(0, (invoice.net_payable ?? invoice.amount) - billedGross);
  const graceEnd = addDaysISO(due, Math.max(0, settings.graceDays));
  const sinceEve = effective.since && ISO_DAY.test(effective.since) ? addDaysISO(effective.since, -1) : null;
  const lastFreeDay = sinceEve && sinceEve > graceEnd ? sinceEve : graceEnd;

  const payments = invoicePaymentTimeline({
    payments: input.payments,
    adjustedPaymentIds: invoice.adjustedPaymentIds,
    paidAmount: invoice.paid_amount ?? 0,
    principal,
    status: invoice.status,
    dueDate: due,
  });
  const r = lateInterest({ principal, dueDate: lastFreeDay, payments, asOf: today, ratePct: settings.interestPct });

  const feeAccrued = r.daysLate > 0 ? settings.flatFee : 0;
  const interestAccrued = interestApplies ? r.interest : 0;
  const feeToBill = feeBilled > 0 ? 0 : feeAccrued;
  const interestToBill = Math.max(0, interestAccrued - interestBilled);
  const toBill = feeToBill + interestToBill;
  const gstToBill = invoice.tax_rate === null ? null : Math.round((toBill * invoice.tax_rate) / 100);

  const reason = r.daysLate === 0
    ? (today <= lastFreeDay ? `No charge until after ${lastFreeDay}.` : "Paid before any charge started.")
    : `${r.daysLate} ${r.daysLate === 1 ? "day" : "days"} late after ${lastFreeDay}.`;

  return {
    ...base,
    applies: true,
    reason,
    lastFreeDay,
    daysLate: r.daysLate,
    outstanding: r.outstanding,
    feeAccrued,
    interestAccrued,
    feeToBill,
    interestToBill,
    toBill,
    gstToBill,
    grossToBill: gstToBill === null ? null : toBill + gstToBill,
    interestFrom: interestToBill > 0 ? addDaysISO(lastFreeDay, 1) : null,
    interestTo: interestToBill > 0 ? today : null,
  };
}

/** Taxable + GST at the invoice's rate — the same arithmetic as bill_late_charges. */
export function lateChargeBillMath(fee: number, interest: number, taxRate: number | null): { taxable: number; gst: number; gross: number } | null {
  if (taxRate === null || !Number.isFinite(taxRate)) return null;
  const taxable = Math.max(0, Math.round(fee)) + Math.max(0, Math.round(interest));
  const gst = Math.round((taxable * taxRate) / 100);
  return { taxable, gst, gross: taxable + gst };
}

/**
 * The sentence the reminder email and the statement carry. Null when there is nothing unbilled
 * to mention. Says "billed separately" because the charge is a separate debit note.
 */
export function lateChargesSentence(v: Pick<LateChargeView, "applies" | "feeToBill" | "interestToBill" | "interestPct" | "daysLate">, rupee: (n: number) => string): string | null {
  if (!v.applies || v.feeToBill + v.interestToBill <= 0) return null;
  const parts: string[] = [];
  if (v.feeToBill > 0) parts.push(`${rupee(v.feeToBill)} late fee`);
  if (v.interestToBill > 0) parts.push(`${rupee(v.interestToBill)} interest (${v.interestPct}% a year for ${v.daysLate} ${v.daysLate === 1 ? "day" : "days"})`);
  return `Late payment charges so far: ${parts.join(" + ")}, plus GST. These are billed separately as a debit note; paying the invoice now stops further interest.`;
}
