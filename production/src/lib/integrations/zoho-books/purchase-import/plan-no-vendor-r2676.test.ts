/**
 * R-2676 (11 Nov 2026) — a Zoho EXPENSE with no vendor comes in as a vendor-less expense. Staging,
 * FY 2025-26: 727 of 794 Zoho expenses had no vendor and were all left out ("It has no vendor in
 * Zoho"). The preview says the same as the SQL import
 * (supabase/tests/r2676_zoho_no_vendor_expenses.test.sql — the same sentences).
 */
import { describe, it, expect } from "vitest";
import { buildPurchasePlan, noVendorRefusal, legsOf, toPurchasePick, NO_VENDOR_REASON, UNMAPPED_CATEGORY, type PurchasePlanContext } from "./plan";
import type { PurchaseFacts } from "./normalise";

const line = (over: Partial<PurchaseFacts["lines"][number]> = {}) => ({
  accountId: "A-RENT", accountName: "Rent", description: "", hsn: "", qty: 1, taxable: 500, tax: 0, itcEligible: true, ...over,
});
/** A Zoho expense with NO vendor, paid from HDFC 4523. */
function expense(over: Partial<PurchaseFacts> = {}): PurchaseFacts {
  return {
    kind: "expenses", zohoId: "N1", number: "", date: "2025-05-20", dueDate: null, status: "nonbillable",
    vendorZohoId: "", vendorName: "", gstin: "", gstTreatment: "", currency: "INR",
    taxable: 500, igst: 0, cgst: 0, sgst: 0, tax: 0, total: 500, rcm: false, rcmTax: 0, tdsAmount: 0, tdsSection: null,
    lines: [line()], paidThrough: "HDFC 4523", problems: [], ...over,
  };
}
const ACCOUNTS = [
  { id: "acc-4523", name: "HDFC Current", bank_name: "HDFC", account_number_last4: "4523", account_type: "current", is_active: true, is_default_petty_cash: false },
];
const ctx = (over: Partial<PurchasePlanContext> = {}): PurchasePlanContext => ({
  fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
  vendors: [{ id: "v-mehta", name: "Mehta Cloud", gstin: "07AAACM1234A1Z5", zohoContactId: null }],
  categoryMap: { "A-RENT": "Office Rent", "A-WEL": "Staff Welfare", "A-COGS": "COGS-Workspace" },
  imported: new Set<string>(),
  bankAccounts: ACCOUNTS,
  accountMap: {},
  ...over,
});
const one = (f: PurchaseFacts, c = ctx()) => buildPurchasePlan([f], c).rows[0];

describe("R-2676 a Zoho expense with no vendor", () => {
  it("on a mapped expense account → imported with no vendor, paid from the mapped account", () => {
    const plan = buildPurchasePlan([expense()], ctx());
    const r = plan.rows[0];
    expect(r.verdict).toBe("import");
    expect(r.reason).toBeNull();
    expect(r.target).toBe("expense");
    expect(r.noVendor).toBe(true);
    expect(r.vendorId).toBeNull();
    expect(r.createVendor).toBe(false);          // no vendor is made for it
    expect(r.accountId).toBe("acc-4523");
    expect(plan.counts).toMatchObject({ import: 1, skip: 0, newVendors: 0, noVendor: 1 });
    expect(toPurchasePick(r)).toEqual({ kind: "expenses", zoho_id: "N1", vendor_id: null, account_id: "acc-4523" });
  });

  it("a Zoho BILL with no vendor still stays out", () => {
    const r = one(expense({ kind: "bills", zohoId: "B9", number: "B-9", status: "open" }));
    expect(r.verdict).toBe("skip");
    expect(r.reason).toBe(NO_VENDOR_REASON);
    expect(r.noVendor).toBe(false);
  });

  it("an unmapped account (fixed deposit, loan, GST, asset, salary) → left out, never 'Unmapped — review'", () => {
    const r = one(expense({ taxable: 100000, total: 100000, lines: [line({ accountId: "A-FD", accountName: "Fixed Deposit", taxable: 100000 })] }));
    expect(r.verdict).toBe("skip");
    expect(r.reason).toBe('Zoho account "Fixed Deposit" is not mapped to an expense category — map it only if it is an expense. A fixed deposit, loan, GST, asset or salary payment is not an expense and stays out.');
    expect(r.target).toBeNull();
    expect(r.noVendor).toBe(false);
  });

  it("one unmapped line among mapped ones → the whole document stays out, naming that account", () => {
    const f = expense({ taxable: 900, total: 900, lines: [line({ taxable: 400 }), line({ accountId: "A-LOAN", accountName: "", taxable: 500 })] });
    expect(one(f).reason).toContain('Zoho account "A-LOAN" is not mapped to an expense category');
    expect(legsOf(f, ctx().categoryMap).map((l) => l.category)).toContain(UNMAPPED_CATEGORY);
  });

  it("a saved map row outside the allowed categories (Salaries) counts as unmapped", () => {
    const r = one(expense({ lines: [line({ accountId: "A-SAL", accountName: "Salaries and wages" })] }), ctx({ categoryMap: { "A-SAL": "Salaries" } }));
    expect(r.verdict).toBe("skip");
    expect(r.reason).toContain('Zoho account "Salaries and wages" is not mapped to an expense category');
  });

  it("claims input GST → left out (ITC needs the supplier); GST Zoho marked ineligible stays in the cost and comes in", () => {
    const claim = one(expense({ igst: 90, tax: 90, total: 590, lines: [line({ tax: 90 })] }));
    expect(claim.verdict).toBe("skip");
    expect(claim.reason).toBe("It claims input GST (or reverse charge) but has no vendor in Zoho — add the vendor in Zoho, or add it by hand with the supplier.");
    const blocked = one(expense({ igst: 36, tax: 36, total: 536, lines: [line({ taxable: 300 }), line({ accountId: "A-WEL", accountName: "Welfare", taxable: 200, tax: 36, itcEligible: false })] }));
    expect(blocked.verdict).toBe("import");
    expect(blocked.noVendor).toBe(true);
    expect(blocked.legs.map((l) => [l.category, l.gst, l.costGst])).toEqual([["Office Rent", 0, 0], ["Staff Welfare", 0, 36]]);
  });

  it("reverse charge → left out", () => {
    const r = one(expense({ rcm: true, rcmTax: 90, lines: [line({ tax: 90 })] }));
    expect(r.reason).toBe("It claims input GST (or reverse charge) but has no vendor in Zoho — add the vendor in Zoho, or add it by hand with the supplier.");
  });

  it("TDS → left out (26Q needs the deductee)", () => {
    const r = one(expense({ tdsAmount: 50, tdsSection: "194J" }));
    expect(r.verdict).toBe("skip");
    expect(r.reason).toBe("It has TDS but no vendor in Zoho — add the vendor in Zoho, or add it by hand.");
  });

  it("the older refusals still come first: a COGS account, and no app account for the paid-through account", () => {
    expect(one(expense({ lines: [line({ accountId: "A-COGS", accountName: "Workspace" })] })).reason).toBe("A Zoho expense on a COGS account — add it as a COGS bill by hand.");
    const noAcct = one(expense({ paidThrough: "Director's wallet" }));
    expect(noAcct.verdict).toBe("skip");
    expect(noAcct.reason).toContain(`Choose the app account for Zoho's "Director's wallet"`);
    expect(noAcct.noVendor).toBe(false);
  });

  it("an expense WITH a vendor is unchanged: matched or created, noVendor false, an unmapped account still 'Unmapped — review'", () => {
    const r = one(expense({ vendorName: "New Stationers", lines: [line({ accountId: "ZZ", accountName: "Misc" })] }));
    expect(r.verdict).toBe("import");
    expect(r.createVendor).toBe(true);
    expect(r.noVendor).toBe(false);
    expect(r.legs[0].category).toBe(UNMAPPED_CATEGORY);
  });

  it("noVendorRefusal order: unmapped account, then GST / reverse charge, then TDS", () => {
    const f = expense({ rcm: true, tdsAmount: 10, tdsSection: "194C", lines: [line({ accountId: "ZZ", accountName: "Loan to director", tax: 90 })] });
    expect(noVendorRefusal(f, legsOf(f, {}), {})).toContain("Loan to director");
    const g = expense({ tdsAmount: 10, tdsSection: "194C", lines: [line({ tax: 90 })] });
    const map = ctx().categoryMap;
    expect(noVendorRefusal(g, legsOf(g, map), map)).toContain("claims input GST");
    expect(noVendorRefusal(expense(), legsOf(expense(), map), map)).toBeNull();
  });
});
