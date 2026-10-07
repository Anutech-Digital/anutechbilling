/**
 * R-368 — late-payment interest on a credit ("Activate now, pay later") invoice.
 *
 * Pardeep (7 Oct 2026): the company is MSME (Udyam) registered; late interest is 18% p.a.
 * SIMPLE, from the due date, worked out per day, in whole rupees. It is SHOWN on the quote;
 * it is only ever charged by an explicit owner/billing click — never added automatically.
 *
 * How it is charged: a DEBIT NOTE on the overdue invoice (issue_debit_note, CGST s.34),
 * reason "additional_charge", tagged in `notes` with LATE_INTEREST_NOTE_PREFIX. Interest on a
 * late payment is part of the value of the supply (CGST s.15(2)(d)), so GST at the invoice's
 * own rate goes on top — the debit note's gross is interest + GST. The card said "add to next
 * invoice"; a debit note on the late invoice is the GST-correct form of that, needs no new
 * table, and works for an annual customer whose next invoice is a year away.
 *
 * Day rule: interest for calendar day d (due < d ≤ asOf) runs on what was still owed at the
 * START of d — payments dated before d. So money received on day D still pays day D's
 * interest (it was late that day) and none after. The year is always 365 days (a leap day is
 * simply one more day). Rounded ONCE, at the end — per-day rounding overcharges.
 *
 * Interest is never charged on interest: the principal is the invoice total minus earlier
 * interest debit notes, and what is already on a debit note is subtracted from "so far".
 */
import { addDaysISO, daysBetweenISO } from "@/lib/dates/ist";

export const LATE_INTEREST_RATE_PCT = 18;
/** Every interest debit note's `notes` starts with this — how earlier charges are found. */
export const LATE_INTEREST_NOTE_PREFIX = "Late payment interest";
/** Owner and billing may charge it (Pardeep, 7 Oct). */
export const LATE_INTEREST_ROLES = ["owner", "billing"] as const;

export interface DatedPayment {
  /** ₹, whole rupees. */
  amount: number;
  /** IST calendar day, YYYY-MM-DD. */
  date: string;
}

export interface LateInterest {
  /** ₹ interest from the due date to `asOf`, whole rupees. */
  interest: number;
  /** Late days on which something was still owed. */
  daysLate: number;
  /** ₹ still owed at the end of `asOf`. */
  outstanding: number;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function lateInterest(input: {
  principal: number;
  dueDate: string;
  payments: readonly DatedPayment[];
  asOf: string;
  ratePct?: number;
}): LateInterest {
  const rate = input.ratePct ?? LATE_INTEREST_RATE_PCT;
  const principal = Number.isFinite(input.principal) ? Math.max(0, Math.round(input.principal)) : 0;
  const due = (input.dueDate ?? "").slice(0, 10);
  const asOf = (input.asOf ?? "").slice(0, 10);
  const pays = input.payments
    .filter((p) => Number.isFinite(p.amount) && p.amount > 0 && ISO_DAY.test((p.date ?? "").slice(0, 10)))
    .map((p) => ({ amount: Math.round(p.amount), date: p.date.slice(0, 10) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const paidBefore = (day: string) => pays.reduce((s, p) => (p.date < day ? s + p.amount : s), 0);
  const owedAtEnd = Math.max(0, principal - pays.reduce((s, p) => (p.date <= asOf ? s + p.amount : s), 0));

  if (!principal || !ISO_DAY.test(due) || !ISO_DAY.test(asOf) || asOf <= due) {
    return { interest: 0, daysLate: 0, outstanding: owedAtEnd };
  }

  /* Walk the late period in segments between payment dates: the balance only changes on the
     day after a payment, so a year late is a handful of steps, not 365. */
  const firstLate = addDaysISO(due, 1);
  const breaks = Array.from(new Set(
    pays.map((p) => addDaysISO(p.date, 1)).filter((d) => d > firstLate && d <= asOf),
  )).sort();
  let rupeeDays = 0;
  let daysLate = 0;
  let start = firstLate;
  for (const next of [...breaks, addDaysISO(asOf, 1)]) {
    const days = daysBetweenISO(start, next);
    const balance = Math.max(0, principal - paidBefore(start));
    if (balance > 0 && days > 0) {
      rupeeDays += balance * days;
      daysLate += days;
    }
    start = next;
  }
  return { interest: Math.round((rupeeDays * rate) / 36_500), daysLate, outstanding: owedAtEnd };
}

export interface InterestNoteRow {
  amount: number;
  taxable_value: number | null;
  notes: string | null;
}

export function isInterestNote(n: Pick<InterestNoteRow, "notes">): boolean {
  return (n.notes ?? "").startsWith(LATE_INTEREST_NOTE_PREFIX);
}

/** Interest already put on debit notes for this invoice: taxable (the interest) and gross. */
export function interestAlreadyCharged(notes: readonly InterestNoteRow[]): { taxable: number; gross: number } {
  return notes.filter(isInterestNote).reduce(
    (acc, n) => ({ taxable: acc.taxable + (n.taxable_value ?? n.amount), gross: acc.gross + n.amount }),
    { taxable: 0, gross: 0 },
  );
}

/** The amount interest runs on: the invoice's total without earlier interest debit notes. */
export function interestPrincipal(
  invoice: { amount: number; net_payable: number | null },
  notes: readonly InterestNoteRow[],
): number {
  const total = invoice.net_payable ?? invoice.amount;
  return Math.max(0, total - interestAlreadyCharged(notes).gross);
}

export function interestToAdd(interestSoFar: number, charged: { taxable: number }): number {
  return Math.max(0, Math.round(interestSoFar) - charged.taxable);
}

/** Debit-note gross: the interest plus GST at the invoice's rate (18 when unknown). */
export function interestDebitNoteGross(interest: number, taxRate: number | null | undefined): number {
  const rate = taxRate ?? 18;
  return interest + Math.round((interest * rate) / 100);
}

export function interestDebitNoteNote(input: { dueDate: string; asOf: string; interest: number }): string {
  return `${LATE_INTEREST_NOTE_PREFIX} @${LATE_INTEREST_RATE_PCT}% p.a. simple, ${input.dueDate.slice(0, 10)} to ${input.asOf.slice(0, 10)}: Rs ${input.interest} + GST (MSMED Act 2006).`;
}

export function mayAddLateInterest(role: string | null | undefined): boolean {
  return Boolean(role) && (LATE_INTEREST_ROLES as readonly string[]).includes(role as string);
}

export interface LateInterestView {
  /** ₹ interest from the due date to today on what was owed. */
  soFar: number;
  /** ₹ interest already on debit notes (before GST). */
  charged: number;
  /** ₹ that the "Add" click would charge now (before GST). */
  toAdd: number;
  daysLate: number;
  dueDate: string;
}

/** What the quote shows for a credit invoice. null = no due date, or nothing late yet. */
export function lateInterestView(input: {
  invoice: { amount: number; net_payable: number | null; due_date: string | null };
  payments: readonly DatedPayment[];
  notes: readonly InterestNoteRow[];
  today: string;
}): LateInterestView | null {
  const dueDate = (input.invoice.due_date ?? "").slice(0, 10);
  if (!dueDate) return null;
  const principal = interestPrincipal(input.invoice, input.notes);
  const r = lateInterest({ principal, dueDate, payments: input.payments, asOf: input.today });
  const charged = interestAlreadyCharged(input.notes);
  if (r.interest <= 0 && charged.taxable <= 0) return null;
  return { soFar: r.interest, charged: charged.taxable, toAdd: interestToAdd(r.interest, charged), daysLate: r.daysLate, dueDate };
}
