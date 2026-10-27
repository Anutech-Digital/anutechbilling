/**
 * Salary status from facts — R-1831 (24 Oct 2026). ONE helper for the Salary Register and
 * the Payroll screens, so the same salary never reads two ways.
 *
 * ─── WHAT THE BOOKS ACTUALLY KNOW ───────────────────────────────────────────
 * "Pay salary" (pay_salary RPC) BOOKS the month's salary — the expense, the payslip — and
 * stores paid_status 'unpaid'. It does not prove any money left. paid_status / paid_amount
 * move only when a bank line is linked to the salary (trigger sync_salary_paid_status). So
 * the payment fact is the bank line:
 *   • linked bank line(s) cover the net         → Paid
 *   • linked bank line(s) cover part of it       → Partial
 *   • nothing linked, but the bank HAS an unlinked
 *     money-out line of exactly this net         → Paid — link bank line (next step: link it)
 *   • nothing linked, no such bank line          → Not paid yet
 *
 * Before this, every unlinked salary read "Awaiting reconcile" — on staging (24 Oct) 13
 * September salaries the bank showed were never paid. Nothing was waiting to reconcile.
 */
import { rupee } from "@/lib/utils";

export type SalaryPayKey = "not_paid" | "link_bank" | "partial" | "paid";

export type SalaryPayFacts = {
  net: number;
  paid_amount: number;
  paid_status: string;
};

export type SalaryPayState = {
  key: SalaryPayKey;
  /** Badge text. */
  label: string;
  tone: "success" | "warning" | "muted";
  /** One plain sentence: what the books know and what to do next. */
  hint: string;
};

/**
 * @param bankLineWaiting  an unlinked money-out bank line of exactly this net exists
 *                         (see salaryBankLineKey) — only consulted when nothing is linked.
 */
export function salaryPayState(p: SalaryPayFacts, bankLineWaiting = false): SalaryPayState {
  const net = Math.max(0, p.net);
  const paid = Math.max(0, p.paid_amount);
  if (p.paid_status === "paid" || (net > 0 && paid >= net)) {
    return { key: "paid", label: "Paid", tone: "success", hint: "Paid — the bank line is linked to this salary." };
  }
  if (paid > 0) {
    return {
      key: "partial", label: "Partial", tone: "warning",
      hint: `${rupee(paid)} of ${rupee(net)} paid from the bank — ${rupee(net - paid)} still to pay. Link the next bank line when it goes out.`,
    };
  }
  if (bankLineWaiting) {
    return {
      key: "link_bank", label: "Paid — link bank line", tone: "warning",
      hint: `The bank shows a ${rupee(net)} payment that is not linked to anything yet. Link it to mark this salary paid.`,
    };
  }
  return {
    key: "not_paid", label: "Not paid yet", tone: "muted",
    hint: "Salary is booked, but no payment for it is in the imported bank statement yet. Once you pay it and import the statement, link that bank line here.",
  };
}

/** The amount key used to look up an unlinked bank line for a salary (whole rupees). */
export const salaryBankLineKey = (amount: number) => Math.round(amount);
