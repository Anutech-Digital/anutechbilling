/**
 * R-2323 — "Set up this loan" from an EMI line on the bank statement.
 *
 * A loan the company TOOK (a bike / car loan, an NBFC loan) that is not in the books yet. It is
 * stored as an EMI loan with no asset (emi_purchases.kind = 'loan', migration r2323), so the
 * whole R-1864 EMI machinery works on it unchanged: the schedule, matching a debit to the next
 * instalment, the principal + interest split, late fee / prepayment, undo and Auto-reconcile.
 *
 * The schedule is the standard reducing-balance one (emi-schedule.ts). When the bank's EMI
 * differs from the computed one, the bank's EMI is kept and each month's interest is worked out
 * from the balance still owed; the last EMI clears whatever is left — no other money rule.
 *
 * Where the loan money went (Pardeep's books-lite model):
 *  - "came into a bank account" → one manual money-in line on that account (the same rule as
 *    record_business_loan): cash up, loan up;
 *  - "taken before these books" (the default from an EMI line) → no bank line: the amount still
 *    owed is an opening balance, like a bank account's opening balance.
 */
import { buildSchedule, emiFor, scheduleTotals, toRpcRows, type ScheduleRow } from "./emi-schedule";

export type LoanSetupInput = {
  lender: string;
  lenderRef?: string | null;
  principal: number;            // ₹ still owed on the first EMI's schedule start
  annualRatePct: number;
  emi: number | null;           // the bank's EMI (from the statement line); null → computed
  months: number;               // EMIs left, counting the first one
  firstDueOn: string;           // YYYY-MM-DD
  receivedInto: { accountId: string; receivedOn: string } | null;
};

export function loanSetupSchedule(i: LoanSetupInput): {
  rows: ScheduleRow[]; computedEmi: number; bankEmiDiffers: boolean; totalInterest: number; error: string | null;
} {
  const computedEmi = emiFor(Math.round(i.principal), i.annualRatePct, Math.round(i.months));
  const bankEmi = i.emi && i.emi > 0 ? Math.round(i.emi) : null;
  try {
    const rows = buildSchedule({
      principal: i.principal, annualRatePct: i.annualRatePct, months: i.months, firstDueOn: i.firstDueOn, emi: bankEmi,
    });
    return {
      rows, computedEmi, bankEmiDiffers: bankEmi !== null && bankEmi !== computedEmi,
      totalInterest: scheduleTotals(rows).interest, error: null,
    };
  } catch (e) {
    return { rows: [], computedEmi, bankEmiDiffers: false, totalInterest: 0, error: e instanceof Error ? e.message : "Check the EMI" };
  }
}

export function loanSetupErrors(i: LoanSetupInput): string[] {
  const out: string[] = [];
  if (!i.lender.trim()) out.push("Enter the lender (bank / NBFC)");
  if (!(i.principal > 0)) out.push("Enter the amount still owed");
  if (!(i.months > 0)) out.push("Enter how many EMIs are left");
  if (!i.firstDueOn) out.push("Enter the first EMI date");
  if (!(i.annualRatePct >= 0)) out.push("Enter the interest rate");
  if (i.receivedInto) {
    if (!i.receivedInto.receivedOn) out.push("Enter the date the loan money came in");
    else if (i.firstDueOn && i.receivedInto.receivedOn > i.firstDueOn) out.push("The loan money must come in on or before the first EMI");
  }
  return out;
}

export function loanSetupPayload(i: LoanSetupInput, rows: ScheduleRow[], reconcileTxnId: string | null) {
  return {
    lender: i.lender.trim(),
    lender_ref: i.lenderRef?.trim() || null,
    principal: Math.round(i.principal),
    interest_rate: i.annualRatePct,
    account_id: i.receivedInto?.accountId ?? null,
    received_on: i.receivedInto?.receivedOn ?? null,
    reconcile_txn_id: reconcileTxnId,
    schedule: toRpcRows(rows),
  };
}

/** A loan set up with no asset (R-2323) — not shown in the asset register / Assets & EMIs. */
/* emi_purchases.kind is newer than the generated types (R-2323), so it is read off the row. */
export const isLoanOnly = (p: object) => (p as { kind?: unknown }).kind === "loan";

/* Common Indian lenders, as a statement narration names them → the name to show. */
const LENDERS: readonly [RegExp, string][] = [
  [/BAJAJ\s*FIN/, "Bajaj Finance"], [/TATA\s*CAP/, "Tata Capital"], [/MAHINDRA\s*(&\s*MAHINDRA\s*)?FIN/, "Mahindra Finance"],
  [/HERO\s*FIN/, "Hero FinCorp"], [/TVS\s*CREDIT/, "TVS Credit"], [/CHOLA/, "Cholamandalam Finance"],
  [/SHRIRAM/, "Shriram Finance"], [/L\s*&\s*T\s*FIN|LTFS/, "L&T Finance"], [/IDFC/, "IDFC First Bank"],
  [/HDFC/, "HDFC Bank"], [/ICICI/, "ICICI Bank"], [/AXIS/, "Axis Bank"], [/KOTAK/, "Kotak Mahindra Bank"],
  [/\bSBI\b|STATE\s*BANK/, "State Bank of India"], [/YES\s*BANK/, "Yes Bank"],
];

/** The lender a statement narration names (a smart default the owner can change), or "". */
export function guessLender(description: string | null | undefined): string {
  const t = (description ?? "").toUpperCase();
  return LENDERS.find(([re]) => re.test(t))?.[1] ?? "";
}
