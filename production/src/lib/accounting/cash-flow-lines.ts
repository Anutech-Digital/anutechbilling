/**
 * Cash-flow drill-down: what each bank line in a month WAS, in the operator's words,
 * and where the month's money went, by that label.
 *
 * The label comes from how the line was reconciled. An unreconciled line says so —
 * it is not guessed from its narration, because "not reconciled yet" is exactly what
 * the operator needs to see to go and fix it.
 */

export type CashFlowTxn = {
  id: string;
  bank_account_id: string;
  txn_date: string;
  description: string | null;
  debit: number;
  credit: number;
  matched_to_type: string | null;
  category: string | null;
  /** R-2575: true when this line is money LENT or its repayment — the same bookings
   *  bank_line_bookings() finds: a balance_sheet_items row in section 'asset' (book_bank_advance
   *  kind 'given'), a Loans given payout (loans_given.bank_txn_id) or a borrower's repayment
   *  (loan_repayments.bank_txn_id). Set by cash-flow/load.ts; absent = not known to be lent. */
  lent?: boolean;
};

/** R-2575: a loan / advance GIVEN, or its repayment — new 'loan_given' lines, and bs_item or old
 *  hand-marked 'manual' lines whose booking says so. One rule for the label and the activity. */
const isLending = (t: Pick<CashFlowTxn, "matched_to_type" | "lent">) =>
  t.matched_to_type === "loan_given"
  || ((t.matched_to_type === "bs_item" || t.matched_to_type === "manual") && t.lent === true);

export const NOT_RECONCILED = "Not reconciled";
export const LENDING_LABEL = "Loans & advances given";

export function lineLabel(t: Pick<CashFlowTxn, "matched_to_type" | "category" | "lent">): string {
  if (isLending(t)) return LENDING_LABEL;
  switch (t.matched_to_type) {
    case null:          return NOT_RECONCILED;
    case "salary":      return "Salary";
    case "split":       return "Salary / advance";
    case "statutory":   return "Tax & statutory";
    case "prepaid":     return "Prepaid advance";
    case "expense":     return t.category ? t.category : "Expense";
    case "vendor_bill": return "Vendor bill";
    case "vendor_payment": return "Vendor payment";   // R-1866: bills / new bill / advance from one line
    case "payment":     return "Customer payment";
    case "project":     return "Project payment";
    case "transfer":    return "Transfer (own accounts)";
    case "manual":      return "Marked reconciled";
    case "owner_equity": return "Owner drawings / capital";
    /* R-2570: the types the loan / advance / challan flows now store (were all "manual"). */
    case "bs_item":       return "Capital / loans (balance sheet)";
    case "employee_loan": return "Staff loans";
    case "reimbursement": return "Reimbursements";
    case "business_loan": case "loan_drawdown": case "loan_repayment": case "emi": return "Loans & EMIs";
    default:            return "Other";
  }
}

export type LabelTotal = { label: string; amount: number; count: number };

/* ── Cash flow statement, direct method (27 Sep 2026) ────────────────────────
   The three activities a CA wants the month's cash sorted into. Classified from how
   the line was reconciled, never from its narration:
     operating — the business itself: customer receipts, vendor bills, expenses, salaries,
                 statutory, advances to vendors
     investing — buying assets: an expense in the Equipment category (the fixed asset
                 register takes it from there); loans and advances GIVEN to third parties and
                 their repayments received (AS-3 para 15(e)/(f), R-2575)
     financing — money in/out of the owner and lenders: capital, drawings, director / owner
                 loans received, business loans taken, drawdowns, repayments and EMIs
   Transfers between own accounts cancel and are left out; unreconciled lines are shown
   apart, because a statement that quietly guesses them is not a statement. */
export type Activity = "operating" | "investing" | "financing" | "transfer" | "unreconciled";

export function activityOf(t: Pick<CashFlowTxn, "matched_to_type" | "category" | "lent">): Activity {
  /* R-2575 (AS-3 para 15(e)/(f)): a loan / advance GIVEN to a third party — and the money it
     brings back — is investing for a non-finance company: Loans given → Give loan and its
     receipts ('loan_given'), and a bs_item / old hand-marked 'manual' line whose booking is a
     loan given (see `lent`). */
  if (isLending(t)) return "investing";
  switch (t.matched_to_type) {
    case null:       return "unreconciled";
    case "transfer": return "transfer";
    case "owner_equity": return "financing";   // R-1839: drawings / capital introduced — the owner, not the business
    /* Loans TAKEN and capital: director / owner loan received and owner capital (bs_item liability /
       equity), business loans, drawdowns, repayments, EMIs. A bs_item / 'manual' line whose booking
       could not be read stays financing, as every such line was before R-2575; old 'manual' staff
       loan / challan / owed-back lines also stay here until the R-2570 repair retypes them. */
    case "bs_item": case "manual":
    case "business_loan": case "loan_drawdown": case "loan_repayment": case "emi":
      return "financing";
    /* Staff loans / salary advances: working capital → operating (R-2575 recommendation, the usual
       Indian practice; recorded as needsDecision on the card for the CA). */
    case "employee_loan": return "operating";
    case "expense":  return t.category === "Equipment" ? "investing" : "operating";
    default:         return "operating";
  }
}

export interface ActivityFlow { activity: Activity; label: string; cashIn: number; cashOut: number; net: number; count: number }
export const ACTIVITY_LABEL: Record<Activity, string> = {
  operating: "Operating activities", investing: "Investing activities (assets, loans given)", financing: "Financing activities (capital, loans taken)",
  transfer: "Transfers between own accounts (excluded)", unreconciled: "Not reconciled — book these first",
};

export function cashFlowByActivity(lines: readonly CashFlowTxn[]): ActivityFlow[] {
  const order: Activity[] = ["operating", "investing", "financing", "unreconciled", "transfer"];
  const m = new Map<Activity, ActivityFlow>(order.map((a) => [a, { activity: a, label: ACTIVITY_LABEL[a], cashIn: 0, cashOut: 0, net: 0, count: 0 }]));
  for (const t of lines) {
    const g = m.get(activityOf(t))!;
    g.cashIn += t.credit || 0; g.cashOut += t.debit || 0; g.net = g.cashIn - g.cashOut; g.count += 1;
  }
  return order.map((a) => m.get(a)!).filter((g) => g.count > 0);
}

/** Totals by label for one side (out = debits, in = credits), biggest first. */
export function totalsByLabel(lines: CashFlowTxn[], side: "out" | "in"): LabelTotal[] {
  const m = new Map<string, LabelTotal>();
  for (const t of lines) {
    const amount = side === "out" ? t.debit : t.credit;
    if (!(amount > 0)) continue;
    const label = lineLabel(t);
    const g = m.get(label) ?? { label, amount: 0, count: 0 };
    g.amount += amount;
    g.count += 1;
    m.set(label, g);
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
}
