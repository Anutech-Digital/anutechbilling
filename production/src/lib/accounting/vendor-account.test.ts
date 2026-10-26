import { describe, it, expect } from "vitest";
import {
  isOpenExpenseBill, expenseBillDue, advanceLeft, vendorBalance, balanceWords, vendorPaymentRows,
  vendorAdvanceLeft, advanceToApply, billAdvanceView, isPartlyPaidExpense, expenseStillOwed,
  cogsBillAdvanceView, advanceHeadDefault,
} from "./vendor-account";

const exp = (o: Partial<Parameters<typeof isOpenExpenseBill>[0]> = {}) => ({
  amount: 11800, paid: false, tds_amount: 0, reconciled_txn_id: null, category: "Professional Services",
  payment_method: null, prepaid_advance_id: null, ...o,
});

describe("open expense bill — the same rule as R-1866's bank_debit_vendor_open_items", () => {
  it("an unpaid bill is open", () => expect(isOpenExpenseBill(exp())).toBe(true));
  it("paid, matched to a bank line, salary, payroll / statutory / EMI / advance rows are not", () => {
    expect(isOpenExpenseBill(exp({ paid: true }))).toBe(false);
    expect(isOpenExpenseBill(exp({ reconciled_txn_id: "t1" }))).toBe(false);
    expect(isOpenExpenseBill(exp({ category: "Salaries" }))).toBe(false);
    for (const m of ["payroll", "statutory", "reimbursement", "emi", "advance", "employee_advance"]) {
      expect(isOpenExpenseBill(exp({ payment_method: m }))).toBe(false);
    }
    expect(isOpenExpenseBill(exp({ prepaid_advance_id: "p1" }))).toBe(false);
    expect(isOpenExpenseBill(exp({ amount: 0 }))).toBe(false);
  });
  it("paid unknown (old row without the column) counts as not open", () => {
    expect(isOpenExpenseBill(exp({ paid: undefined as unknown as boolean }))).toBe(false);
  });
  it("what is still owed = amount less the TDS already on the bill", () => {
    expect(expenseBillDue(exp({ tds_amount: 1000 }))).toBe(10800);
    expect(expenseBillDue(exp({ paid: true }))).toBe(0);
  });
});

describe("advance still with the vendor", () => {
  it("total less used; a closed advance is nothing", () => {
    expect(advanceLeft({ total_amount: 5000, consumed_amount: 1200, closed_at: null })).toBe(3800);
    expect(advanceLeft({ total_amount: 5000, consumed_amount: 5000, closed_at: null })).toBe(0);
    expect(advanceLeft({ total_amount: 5000, consumed_amount: 0, closed_at: "2026-10-01T00:00:00Z" })).toBe(0);
  });
});

describe("vendor balance — one line", () => {
  it("owe", () => {
    const b = vendorBalance(70800, 0);
    expect(b).toEqual({ bills: 70800, advance: 0, net: 70800, state: "owe" });
    expect(balanceWords(b).headline).toBe("You owe ₹70,800");
  });
  it("advance bigger than the bills → the vendor holds your money", () => {
    const b = vendorBalance(2000, 5000);
    expect(b.state).toBe("advance");
    expect(b.net).toBe(-3000);
    expect(balanceWords(b).headline).toBe("Advance with vendor ₹3,000");
  });
  it("bills and advance both there → net, and says both", () => {
    const b = vendorBalance(10000, 4000);
    expect(b.net).toBe(6000);
    expect(balanceWords(b).headline).toBe("You owe ₹6,000");
    expect(balanceWords(b).detail).toBe("Open bills ₹10,000 − advance ₹4,000");
  });
  it("nothing due, no advance → settled", () => {
    const b = vendorBalance(0, 0);
    expect(b.state).toBe("settled");
    expect(balanceWords(b).headline).toBe("All settled");
  });
});

describe("payments made to the vendor", () => {
  const accounts = new Map([["a1", "HDFC Current"]]);
  it("bank lines + their TDS, plus bills paid outside the bank, newest first", () => {
    const rows = vendorPaymentRows({
      bankLines: [
        { id: "t1", txn_date: "2026-10-10", debit: 64800, matched_to_type: "vendor_payment", matched_to_id: "v1", bank_account_id: "a1", reference: "U1" },
        { id: "t2", txn_date: "2026-09-01", debit: 11800, matched_to_type: "vendor_bill", matched_to_id: "B1", bank_account_id: "a1", reference: null },
        { id: "t3", txn_date: "2026-09-15", debit: 5000, matched_to_type: "prepaid", matched_to_id: "p1", bank_account_id: "a1", reference: null },
      ],
      paymentLines: [
        { bank_txn_id: "t1", kind: "expense", tds_amount: 4000, expense_id: "E1", vendor_bill_id: null, cash: 43200 },
        { bank_txn_id: "t1", kind: "expense", tds_amount: 2000, expense_id: "E2", vendor_bill_id: null, cash: 21600 },
      ],
      docNo: new Map([["E1", "KL-201"], ["E2", "KL-202"], ["B1", "G-1"]]),
      paidOutsideBank: [{ id: "E9", bill_no: "R-7", paid_date: "2026-08-05", amount: 3000, tds_amount: 0, payment_method: "cash" }],
      accounts,
    });
    expect(rows.map((r) => r.date)).toEqual(["2026-10-10", "2026-09-15", "2026-09-01", "2026-08-05"]);
    expect(rows[0]).toMatchObject({ cash: 64800, tds: 6000, via: "HDFC Current", what: "Bills KL-201, KL-202" });
    expect(rows[1]).toMatchObject({ cash: 5000, tds: 0, what: "Advance" });
    expect(rows[2]).toMatchObject({ cash: 11800, what: "Bill G-1" });
    expect(rows[3]).toMatchObject({ cash: 3000, via: "cash", what: "Bill R-7", href: "/accounting/expenses?edit=E9" });
    expect(rows[0].href).toBe("/accounting/banking/a1?focus=t1");
  });
  it("an expense matched to a bank line is listed once (the bank line), not again as paid outside", () => {
    const rows = vendorPaymentRows({
      bankLines: [{ id: "t5", txn_date: "2026-10-01", debit: 2000, matched_to_type: "expense", matched_to_id: "E5", bank_account_id: "a1", reference: null }],
      paymentLines: [],
      docNo: new Map([["E5", "X-5"]]),
      paidOutsideBank: [],
      accounts,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].what).toBe("Bill X-5");
  });
  it("a bank line that paid an advance and a bank charge says so", () => {
    const rows = vendorPaymentRows({
      bankLines: [{ id: "t6", txn_date: "2026-10-02", debit: 5100, matched_to_type: "vendor_payment", matched_to_id: "v1", bank_account_id: "a1", reference: null }],
      paymentLines: [
        { bank_txn_id: "t6", kind: "advance", tds_amount: 0, expense_id: null, vendor_bill_id: null, cash: 5000 },
        { bank_txn_id: "t6", kind: "bank_charge", tds_amount: 0, expense_id: "EXP-BC", vendor_bill_id: null, cash: 100 },
      ],
      docNo: new Map(), paidOutsideBank: [], accounts,
    });
    expect(rows[0].what).toBe("Advance + bank charge");
  });
  it("an advance paid without a bank line (cash) is a payment too", () => {
    const rows = vendorPaymentRows({
      bankLines: [], paymentLines: [], docNo: new Map(), paidOutsideBank: [], accounts,
      advancesOutsideBank: [{ id: "p9", paid_date: "2026-10-05", total_amount: 5000, payment_method: "cash" }],
    });
    expect(rows).toEqual([{ key: "adv:p9", date: "2026-10-05", cash: 5000, tds: 0, via: "cash", what: "Advance", href: "/accounting/prepaid" }]);
  });
});

/* R-1913 (R-1906 audit B2/B3): Verma — ₹30,000 advance from the bank, ₹50,000 bill on Expenses. */
describe("R-1913 — the vendor's advance on a bill", () => {
  const VERMA = "v-verma";
  const adv = (o: Partial<{ vendor_id: string | null; vendor_name: string | null; total_amount: number; consumed_amount: number; closed_at: string | null; category: string | null }> = {}) => ({
    vendor_id: VERMA, vendor_name: "Verma Contractors", total_amount: 30000, consumed_amount: 0, closed_at: null, category: "Repairs & Maintenance", ...o,
  });
  const bill = (o: Partial<Parameters<typeof billAdvanceView>[0]> = {}) => ({
    ...exp({ amount: 50000, category: "Repairs & Maintenance" }), vendor_id: VERMA, vendor_name: "Verma Contractors", advance_applied: 0, ...o,
  });

  it("before: the bill offers 'Apply advance ₹30,000'; after: ₹20,000 due, nothing more to apply", () => {
    expect(billAdvanceView(bill(), [adv()])).toEqual({ applied: 0, paidPart: 0, due: 50000, canApply: 30000, canUndo: false });
    expect(billAdvanceView(bill({ advance_applied: 30000 }), [adv({ consumed_amount: 30000 })]))
      .toEqual({ applied: 30000, paidPart: 0, due: 20000, canApply: 0, canUndo: true });
  });

  it("the popup's due takes the advance applied off (You owe ₹20,000, not ₹50,000)", () => {
    expect(expenseBillDue(bill({ advance_applied: 30000 }))).toBe(20000);
    expect(vendorBalance(expenseBillDue(bill({ advance_applied: 30000 })), 0)).toMatchObject({ net: 20000, state: "owe" });
  });

  it("a bill settled by the advance is no longer open; undo is still offered", () => {
    const settled = bill({ amount: 20000, advance_applied: 20000, paid: true, payment_method: "advance" });
    expect(isOpenExpenseBill(settled)).toBe(false);
    expect(billAdvanceView(settled, [adv({ consumed_amount: 20000 })])).toMatchObject({ due: 0, canApply: 0, canUndo: true });
  });

  it("no undo once a bank line (or Mark paid) settled the rest", () => {
    expect(billAdvanceView(bill({ advance_applied: 30000, paid: true, reconciled_txn_id: "t1", payment_method: "bank" }), []).canUndo).toBe(false);
    expect(billAdvanceView(bill({ advance_applied: 30000, paid: true, payment_method: "neft" }), []).canUndo).toBe(false);
  });

  it("advance left: by vendor id (renamed vendor), by name when the advance has no vendor; never staff advances", () => {
    expect(vendorAdvanceLeft([adv({ vendor_name: "Old name" })], VERMA, "Verma Contractors")).toBe(30000);
    expect(vendorAdvanceLeft([adv({ vendor_id: null, vendor_name: " verma contractors " })], VERMA, "Verma Contractors")).toBe(30000);
    expect(vendorAdvanceLeft([adv({ vendor_id: "other" })], VERMA, "Verma Contractors")).toBe(0);
    expect(vendorAdvanceLeft([adv({ category: "Employee advance" })], VERMA, "Verma Contractors")).toBe(0);
    expect(vendorAdvanceLeft([adv({ closed_at: "2026-10-01" })], VERMA, "Verma Contractors")).toBe(0);
  });

  it("apply at most the bill's due, and never more than the advance", () => {
    expect(advanceToApply(30000, 20000)).toBe(20000);
    expect(advanceToApply(30000, 50000)).toBe(30000);
    expect(advanceToApply(0, 50000)).toBe(0);
  });
});

/* R-1915 (R-1906 audit B5): Sharma Associates — ₹59,000 bill PS-1, ₹25,000 paid from a bank line. */
describe("R-1915 — an expense bill paid in parts", () => {
  const ps1 = (o: Partial<Parameters<typeof billAdvanceView>[0]> = {}) => ({
    ...exp({ amount: 59000 }), vendor_id: "v-sharma", vendor_name: "Sharma Associates", advance_applied: 0, paid_amount: 0, ...o,
  });

  it("₹25,000 paid → 'Partly paid', ₹34,000 due (popup and the bill row)", () => {
    const b = ps1({ paid_amount: 25000 });
    expect(isPartlyPaidExpense(b)).toBe(true);
    expect(isOpenExpenseBill(b)).toBe(true);
    expect(expenseBillDue(b)).toBe(34000);
    expect(vendorBalance(expenseBillDue(b), 0)).toMatchObject({ net: 34000, state: "owe" });
    expect(billAdvanceView(b, [])).toEqual({ applied: 0, paidPart: 25000, due: 34000, canApply: 0, canUndo: false });
    expect(expenseStillOwed(b)).toBe(34000);
  });

  it("not yet paid: not 'Partly paid'; still owed is the bill less the advance (TDS taken when paid)", () => {
    expect(isPartlyPaidExpense(ps1())).toBe(false);
    expect(expenseStillOwed(ps1({ tds_amount: 5000 }))).toBe(59000);
    expect(expenseStillOwed(ps1({ advance_applied: 9000 }))).toBe(50000);
  });

  it("TDS ₹5,000 went with the first part (₹20,000 cash) → ₹34,000 cash due", () => {
    const b = ps1({ paid_amount: 20000, tds_amount: 5000 });
    expect(expenseBillDue(b)).toBe(34000);
    expect(expenseStillOwed(b)).toBe(34000);
  });

  it("the rest paid → no longer open; with an advance + part the due is what is left", () => {
    expect(isOpenExpenseBill(ps1({ paid_amount: 59000 }))).toBe(false);
    expect(isPartlyPaidExpense(ps1({ paid_amount: 59000, paid: true }))).toBe(false);
    const v = billAdvanceView(ps1({ amount: 50000, advance_applied: 30000, paid_amount: 5000 }), []);
    expect(v).toMatchObject({ applied: 30000, paidPart: 5000, due: 15000, canUndo: false });
  });
});

describe("R-1914 — a COGS vendor's advance on a COGS bill (Bills page)", () => {
  const adv = (o: Partial<Parameters<typeof vendorAdvanceLeft>[0][number]> = {}) => ({
    total_amount: 11800, consumed_amount: 0, closed_at: null, vendor_id: "g", vendor_name: "Google Cloud India", category: "COGS-Workspace", ...o,
  });
  const bill = (o: Partial<Parameters<typeof cogsBillAdvanceView>[0]> = {}) => ({
    total: 11800, paid_amount: 0, status: "unpaid", currency: "INR", advance_applied: 0, vendor_id: "g", vendor_name: "Google Cloud India", ...o,
  });
  it("Google ₹11,800 advance + ₹11,800 COGS bill → Apply advance ₹11,800 (the COGS head no longer hides it)", () => {
    expect(cogsBillAdvanceView(bill(), [adv()])).toEqual({ applied: 0, due: 11800, canApply: 11800, canUndo: false });
  });
  it("after Apply: paid by the advance, Undo offered, nothing more to apply", () => {
    expect(cogsBillAdvanceView(bill({ paid_amount: 11800, advance_applied: 11800, status: "paid" }), [adv({ consumed_amount: 11800 })]))
      .toEqual({ applied: 11800, due: 0, canApply: 0, canUndo: true });
  });
  it("part: ₹5,000 advance on an ₹11,800 bill leaves ₹6,800 due", () => {
    expect(cogsBillAdvanceView(bill({ paid_amount: 5000, advance_applied: 5000, status: "partial" }), [adv({ total_amount: 5000, consumed_amount: 5000 })]))
      .toEqual({ applied: 5000, due: 6800, canApply: 0, canUndo: true });
  });
  it("another vendor's advance, a foreign-currency bill, or a bill without the column → nothing to apply", () => {
    expect(cogsBillAdvanceView(bill(), [adv({ vendor_id: "aws", vendor_name: "AWS" })]).canApply).toBe(0);
    expect(cogsBillAdvanceView(bill({ currency: "USD" }), [adv()]).canApply).toBe(0);
    expect(cogsBillAdvanceView(bill({ advance_applied: undefined }), [adv()])).toMatchObject({ applied: 0, canApply: 11800 });
  });
});

describe("R-1914 — the head an advance is saved under (Banking → Paying a vendor?)", () => {
  it("a COGS vendor keeps its COGS head — not 'Other'", () => {
    expect(advanceHeadDefault("COGS-Workspace")).toBe("COGS-Workspace");
    expect(advanceHeadDefault("Professional Services")).toBe("Professional Services");
  });
  it("no head, or Salaries → Other", () => {
    expect(advanceHeadDefault(null)).toBe("Other");
    expect(advanceHeadDefault("  ")).toBe("Other");
    expect(advanceHeadDefault("Salaries")).toBe("Other");
  });
});
