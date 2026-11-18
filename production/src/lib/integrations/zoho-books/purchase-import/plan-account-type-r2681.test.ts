/**
 * R-2681 (17 Nov 2026) — Zoho's OWN account type keeps balance-sheet accounts out of the FY purchase
 * import even when the owner mapped them, and (owner decision 17 Nov, "Haan, teeno") a document on an
 * unmapped account is left out. The preview says what the SQL import says
 * (supabase/tests/r2681_zoho_account_type_refusal.test.sql — the same sentences, the same order).
 */
import { describe, it, expect } from "vitest";
import { buildPurchasePlan, type PurchasePlanContext } from "./plan";
import type { PurchaseFacts } from "./normalise";
import {
  NO_ACCOUNT_LINE, TYPES_MAX_AGE_MS, TYPES_NOT_READ, accountTypeRefusal, accountTypeRows, isExpenseType, notAnExpenseReason, typesStale, unmappedRefusal,
} from "./account-types";

const line = (over: Partial<PurchaseFacts["lines"][number]> = {}) => ({
  accountId: "A-RENT", accountName: "Rent", description: "", hsn: "", qty: 1, taxable: 500, tax: 0, itcEligible: true, ...over,
});
function doc(over: Partial<PurchaseFacts> = {}): PurchaseFacts {
  return {
    kind: "expenses", zohoId: "E1", number: "", date: "2025-05-20", dueDate: null, status: "nonbillable",
    vendorZohoId: "VZ1", vendorName: "Mehta Cloud", gstin: "", gstTreatment: "", currency: "INR",
    taxable: 500, igst: 0, cgst: 0, sgst: 0, tax: 0, total: 500, rcm: false, rcmTax: 0, tdsAmount: 0, tdsSection: null,
    lines: [line()], paidThrough: "HDFC 4523", problems: [], ...over,
  };
}
const ctx = (over: Partial<PurchasePlanContext> = {}): PurchasePlanContext => ({
  fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
  vendors: [{ id: "v-mehta", name: "Mehta Cloud", gstin: null, zohoContactId: "VZ1" }],
  /* The owner mapped the FD and Output GST accounts — the map alone must not let them in. */
  categoryMap: { "A-RENT": "Office Rent", "A-FD": "Rates & Taxes", "A-OGST": "Rates & Taxes", "A-COGS": "COGS-Workspace", "A-LOAN": "Other" },
  imported: new Set<string>(),
  bankAccounts: [{ id: "acc-4523", name: "HDFC Current", bank_name: "HDFC", account_number_last4: "4523", account_type: "current", is_active: true, is_default_petty_cash: false }],
  accountMap: {},
  accountTypes: {
    "A-RENT": "expense", "A-FD": "other_current_asset", "A-OGST": "other_current_liability", "A-COGS": "cost_of_goods_sold",
    "A-LOAN": "long_term_liability", "A-MISC": "other_expense", "A-SAL": "expense",
  },
  ...over,
});
const one = (f: PurchaseFacts, c = ctx()) => buildPurchasePlan([f], c).rows[0];

describe("R-2681 Zoho's own account type", () => {
  it("expense / other_expense / cost_of_goods_sold are the only expense types", () => {
    expect(["expense", "other_expense", "cost_of_goods_sold", " Expense "].map(isExpenseType)).toEqual([true, true, true, true]);
    expect(["other_current_asset", "other_current_liability", "fixed_asset", "long_term_liability", "equity", "bank", "cash", "income", "", null]
      .map(isExpenseType).every((x) => x === false)).toBe(true);
  });

  it("a MAPPED fixed deposit (no vendor) and a mapped Output GST bill are 'Not an expense — needs another path'", () => {
    const fd = one(doc({ vendorName: "", vendorZohoId: "", lines: [line({ accountId: "A-FD", accountName: "Fixed Deposit HDFC", taxable: 8500000 })] }));
    expect(fd).toMatchObject({ verdict: "skip", target: null,
      reason: 'Not an expense — needs another path: in Zoho, "Fixed Deposit HDFC" is an account of type "other current asset". Fixed deposits, loans, GST, assets and advances are never booked as an expense.' });
    const gst = one(doc({ kind: "bills", zohoId: "B1", number: "B-1", status: "open", lines: [line({ accountId: "A-OGST", accountName: "Output CGST" })] }));
    expect(gst).toMatchObject({ verdict: "skip", reason: notAnExpenseReason("Output CGST", "other_current_liability") });
  });

  it("expense and COGS types come in as before", () => {
    expect(one(doc()).verdict).toBe("import");
    expect(one(doc({ lines: [line({ accountId: "A-COGS", accountName: "Workspace" })], kind: "bills", zohoId: "B2", number: "B-2", status: "open" })))
      .toMatchObject({ verdict: "import", target: "vendor_bill" });
  });

  it("one rent line + one loan line → the whole document is left out (never a part of it)", () => {
    const r = one(doc({ lines: [line({ taxable: 300 }), line({ accountId: "A-LOAN", accountName: "Loan from director", taxable: 700 })] }));
    expect(r).toMatchObject({ verdict: "skip", reason: notAnExpenseReason("Loan from director", "long_term_liability") });
  });

  it("fail closed: no types read → left out; an account missing from the read types → left out by name; a known non-expense line is named first", () => {
    expect(one(doc(), ctx({ accountTypes: {} }))).toMatchObject({ verdict: "skip", reason: TYPES_NOT_READ });
    const missing = one(doc({ lines: [line({ accountId: "A-NEW", accountName: "Made after the read" })] }), ctx({ categoryMap: { "A-NEW": "Office Rent" } }));
    expect(missing.reason).toBe('Zoho\'s account type for "Made after the read" is not read yet — press Read from Zoho again, then preview again.');
    expect(accountTypeRefusal([line({ accountId: "A-NEW", accountName: "New" }), line({ accountId: "A-FD", accountName: "FD" })], ctx().accountTypes))
      .toBe(notAnExpenseReason("FD", "other_current_asset"));
  });

  it("a line with no Zoho account → left out ('add it by hand'), before anything else about types", () => {
    expect(one(doc({ lines: [line(), line({ accountId: " ", accountName: "" })] }), ctx({ accountTypes: {} })))
      .toMatchObject({ verdict: "skip", reason: NO_ACCOUNT_LINE });
  });

  it("a rerun of an imported document stays 'already' even with no types read", () => {
    expect(one(doc(), ctx({ accountTypes: {}, imported: new Set(["expenses:E1"]) })).verdict).toBe("already");
  });

  it("the Unmapped list carries Zoho's type; a non-expense one is flagged (no category offered)", () => {
    const p = buildPurchasePlan([
      doc({ zohoId: "E7", lines: [line({ accountId: "A-GSTR", accountName: "GST Return" })] }),
      doc({ zohoId: "E8", lines: [line({ accountId: "A-MISC", accountName: "Misc charges" })] }),
    ], ctx({ accountTypes: { ...ctx().accountTypes, "A-GSTR": "other_current_liability" } }));
    expect(p.unmapped).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: "A-GSTR", type: "other_current_liability", notExpense: true }),
      expect.objectContaining({ accountId: "A-MISC", type: "other_expense", notExpense: false }),
    ]));
    expect(p.rows.map((r) => r.verdict)).toEqual(["skip", "skip"]);
  });
});

describe("R-2681 owner decision 17 Nov — unmapped accounts stay out", () => {
  it("an unmapped expense account → left out ('not mapped — left out for now'), bills and expenses alike", () => {
    const r = one(doc({ lines: [line({ accountId: "A-MISC", accountName: "Misc charges" })] }));
    expect(r).toMatchObject({ verdict: "skip", reason: 'Zoho account "Misc charges" is not mapped — left out for now (owner, 17 Nov). Map it only if it is an expense.' });
    const b = one(doc({ kind: "bills", zohoId: "B3", number: "B-3", status: "open", lines: [line({ accountId: "A-MISC", accountName: "Misc charges" })] }));
    expect(b.verdict).toBe("skip");
  });

  it("R-2911 corrects the 17 Nov salary decision: a salary account is Salaries, not unmapped — it comes in when Payroll has no payslip", () => {
    /* Was: "is a salary — Payroll books salaries" (refused). Excel's Payroll starts Jun 2026, so FY 2025-26 salaries
       come only from Zoho; plan-salary-r2911.test.ts has the Payroll cases. */
    const r = one(doc({ vendorName: "Prashant", vendorZohoId: "VZ-P", zohoId: "E-SAL",
      lines: [line({ accountId: "A-SAL", accountName: "Salaries and wages", taxable: 15000 })] }));
    expect(r).toMatchObject({ verdict: "import", target: "expense" });
    expect(r.legs.map((l) => l.category)).toEqual(["Salaries"]);
    /* A Zoho salary BILL would land unpaid with no pay path — it stays out (R-2911). */
    expect(one(doc({ vendorName: "Prashant", vendorZohoId: "VZ-P", kind: "bills", zohoId: "B4", number: "SAL-1", status: "open",
      lines: [line({ accountId: "A-SAL", accountName: "Salaries and wages", taxable: 15000 })] })).reason).toMatch(/^A Zoho salary bill stays out/);
  });

  it("a Zoho expense with no vendor keeps R-2676's sentence", () => {
    expect(unmappedRefusal([line({ accountId: "X", accountName: "Loan" })], () => false, true)).toMatch(/^Zoho account "Loan" is not mapped to an expense category/);
  });
});

describe("R-2681 reading the types", () => {
  it("stale when none are stored, the newest is over 12 h old, or older than the current list read's start", () => {
    const now = Date.parse("2026-11-17T12:00:00Z");
    expect(typesStale("2026-11-17T10:00:00Z", now, "2026-11-17T11:00:00Z")).toBe(true);
    expect(typesStale("2026-11-17T11:30:00Z", now, "2026-11-17T11:00:00Z")).toBe(false);
    expect(typesStale("2026-11-17T11:30:00Z", now, null)).toBe(false);
    expect(typesStale(null, now)).toBe(true);
    expect(typesStale("garbage", now)).toBe(true);
    expect(typesStale(new Date(now - TYPES_MAX_AGE_MS + 1000).toISOString(), now)).toBe(false);
    expect(typesStale(new Date(now - TYPES_MAX_AGE_MS - 1000).toISOString(), now)).toBe(true);
  });

  it("rows: ids and types trimmed, type lower-cased, empty / too long / repeated ids dropped", () => {
    const rows = accountTypeRows([
      { id: " A1 ", name: " Rent ", code: "", type: " Expense ", active: true },
      { id: "A1", name: "dup", code: "", type: "bank", active: true },
      { id: "", name: "x", code: "", type: "expense", active: true },
      { id: "A2", name: "no type", code: "", type: "", active: true },
      { id: "x".repeat(41), name: "long", code: "", type: "expense", active: true },
    ]);
    expect(rows).toEqual([{ zoho_account_id: "A1", zoho_account_name: "Rent", account_type: "expense" }]);
  });
});
