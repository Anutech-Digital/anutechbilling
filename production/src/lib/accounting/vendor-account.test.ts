import { describe, it, expect } from "vitest";
import {
  isOpenExpenseBill, expenseBillDue, advanceLeft, vendorBalance, balanceWords, vendorPaymentRows,
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
