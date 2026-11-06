/**
 * R-2502 — the preview plan for FY bills / expenses (pure). The SQL import makes the same calls
 * (supabase/tests/r2502_zoho_fy_purchase_import.test.sql); this is what the owner sees first.
 */
import { describe, it, expect } from "vitest";
import { buildPurchasePlan, buildPaymentPlan, legsOf, toPurchasePick, UNMAPPED_CATEGORY, canImportFyPurchases, CATEGORY_CHOICES, type PurchasePlanContext } from "./plan";
import type { PurchaseFacts, VendorPaymentFacts } from "./normalise";

const line = (over: Partial<PurchaseFacts["lines"][number]> = {}) => ({
  accountId: "A1", accountName: "Software", description: "", hsn: "", qty: 1, taxable: 1000, tax: 180, itcEligible: true, ...over,
});
function bill(over: Partial<PurchaseFacts> = {}): PurchaseFacts {
  return {
    kind: "bills", zohoId: "B1", number: "VB-1", date: "2025-05-10", dueDate: "2025-06-09", status: "open",
    vendorZohoId: "V1", vendorName: "Mehta Cloud", gstin: "07AAACM1234A1Z5", gstTreatment: "business_gst", currency: "INR",
    taxable: 1000, igst: 0, cgst: 90, sgst: 90, tax: 180, total: 1180, rcm: false, rcmTax: 0, tdsAmount: 0, tdsSection: null,
    lines: [line()], paidThrough: "", problems: [], ...over,
  };
}
const ACCOUNTS = [
  { id: "acc-4523", name: "HDFC Current", bank_name: "HDFC", account_number_last4: "4523", account_type: "current", is_active: true, is_default_petty_cash: false },
  { id: "acc-cash", name: "Petty Cash", bank_name: "Cash", account_number_last4: null, account_type: "cash", is_active: true, is_default_petty_cash: true },
];
const ctx = (over: Partial<PurchasePlanContext> = {}): PurchasePlanContext => ({
  fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
  vendors: [{ id: "v-mehta", name: "Mehta Cloud", gstin: "07AAACM1234A1Z5", zohoContactId: null }],
  categoryMap: { A1: "Software", A2: "Staff Welfare", AC: "COGS-Workspace" },
  imported: new Set<string>(),
  bankAccounts: ACCOUNTS,
  accountMap: {},
  ...over,
});

describe("roles", () => {
  it("only owner and accountant", () => {
    expect(canImportFyPurchases("owner")).toBe(true);
    expect(canImportFyPurchases("accountant")).toBe(true);
    expect(canImportFyPurchases("manager")).toBe(false);
    expect(canImportFyPurchases(undefined)).toBe(false);
  });
  it("Salaries is not a category to map to (Payroll books it)", () => {
    expect(CATEGORY_CHOICES).not.toContain("Salaries");
    expect(CATEGORY_CHOICES).toContain("COGS-Workspace");
  });
});

describe("legsOf — one expense row per category; ineligible GST stays a cost", () => {
  it("single category, all ITC eligible: heads kept", () => {
    expect(legsOf(bill(), { A1: "Software" })).toEqual([
      { category: "Software", taxable: 1000, gst: 180, costGst: 0, rcmTax: 0, heads: { igst: 0, cgst: 90, sgst: 90 } },
    ]);
  });
  it("two categories + an ineligible line: the blocked GST in the cost; heads on the claimable part", () => {
    const f = bill({ taxable: 1000, tax: 180, lines: [line({ taxable: 500, tax: 90 }), line({ accountId: "A2", taxable: 500, tax: 90, itcEligible: false })] });
    expect(legsOf(f, { A1: "Software", A2: "Staff Welfare" })).toEqual([
      { category: "Software", taxable: 500, gst: 90, costGst: 0, rcmTax: 0, heads: { igst: 0, cgst: 45, sgst: 45 } },
      { category: "Staff Welfare", taxable: 500, gst: 0, costGst: 90, rcmTax: 0, heads: { igst: 0, cgst: 0, sgst: 0 } },
    ]);
  });
  it("an account with no mapping → Unmapped — review", () => {
    expect(legsOf(bill({ lines: [line({ accountId: "ZZ" })] }), {})[0].category).toBe(UNMAPPED_CATEGORY);
  });
  it("RCM: tax is ours to pay (rcmTax), none charged", () => {
    const l = legsOf(bill({ rcm: true, tax: 0, igst: 0, cgst: 0, sgst: 0, rcmTax: 180, total: 1000 }), { A1: "Software" });
    expect(l).toEqual([{ category: "Software", taxable: 1000, gst: 0, costGst: 0, rcmTax: 180, heads: null }]);
  });
});

describe("buildPurchasePlan — verdicts", () => {
  it("a good bill: import as an expense bill, vendor matched by GSTIN", () => {
    const p = buildPurchasePlan([bill()], ctx());
    expect(p.rows[0]).toMatchObject({ verdict: "import", target: "expense", vendorId: "v-mehta", createVendor: false });
    expect(p.counts).toMatchObject({ scanned: 1, import: 1, already: 0, skip: 0 });
  });

  it("all lines COGS → a COGS bill (vendor_bills)", () => {
    const p = buildPurchasePlan([bill({ lines: [line({ accountId: "AC" })] })], ctx());
    expect(p.rows[0]).toMatchObject({ verdict: "import", target: "vendor_bill" });
  });

  it("COGS and expense lines on one bill → left out (add by hand)", () => {
    const p = buildPurchasePlan([bill({ lines: [line({ accountId: "AC", taxable: 500, tax: 90 }), line({ taxable: 500, tax: 90 })] })], ctx());
    expect(p.rows[0].verdict).toBe("skip");
    expect(p.rows[0].reason).toMatch(/COGS/);
  });

  it("void / draft left out and counted", () => {
    const p = buildPurchasePlan([bill({ status: "void" }), bill({ zohoId: "B2", status: "draft" })], ctx());
    expect(p.rows.map((r) => r.verdict)).toEqual(["skip", "skip"]);
    expect(p.counts.voidOrDraft).toBe(2);
    expect(p.rows[0].reason).toMatch(/Void/);
  });

  it("before the books start, or inside the books lock → left out", () => {
    expect(buildPurchasePlan([bill()], ctx({ booksStart: "2025-06-01" })).rows[0].reason).toMatch(/before the books start/);
    expect(buildPurchasePlan([bill()], ctx({ lockedUntil: "2025-05-31" })).rows[0].reason).toMatch(/books lock/);
    expect(buildPurchasePlan([bill()], ctx({ booksStart: null })).rows[0].reason).toMatch(/books start date is not set/);
  });

  it("already imported (same Zoho id) → already", () => {
    const p = buildPurchasePlan([bill()], ctx({ imported: new Set(["bills:B1"]) }));
    expect(p.rows[0].verdict).toBe("already");
  });

  it("unknown vendor → created from Zoho; two vendors with that name and no GSTIN match → left out", () => {
    const a = buildPurchasePlan([bill({ vendorName: "New Co", gstin: "" })], ctx());
    expect(a.rows[0]).toMatchObject({ verdict: "import", vendorId: null, createVendor: true });
    expect(a.counts.newVendors).toBe(1);
    const twins = [{ id: "x", name: "Twin", gstin: null, zohoContactId: null }, { id: "y", name: "twin", gstin: null, zohoContactId: null }];
    const b = buildPurchasePlan([bill({ vendorName: "Twin", gstin: "" })], ctx({ vendors: twins }));
    expect(b.rows[0].verdict).toBe("skip");
  });

  it("vendor matched by its Zoho contact id first", () => {
    const p = buildPurchasePlan([bill({ gstin: "" })], ctx({ vendors: [{ id: "vz", name: "Other name", gstin: null, zohoContactId: "V1" }] }));
    expect(p.rows[0].vendorId).toBe("vz");
  });

  it("unmapped Zoho accounts are listed (with amount), and the doc still imports", () => {
    const p = buildPurchasePlan([bill({ lines: [line({ accountId: "ZZ", accountName: "Misc Exp" })] })], ctx());
    expect(p.rows[0].verdict).toBe("import");
    expect(p.unmapped).toEqual([{ accountId: "ZZ", accountName: "Misc Exp", count: 1, taxable: 1000 }]);
  });

  it("a problem from the normaliser leaves it out with that reason", () => {
    const p = buildPurchasePlan([bill({ problems: ["In USD — only rupee (INR) documents are imported."] })], ctx());
    expect(p.rows[0]).toMatchObject({ verdict: "skip", reason: expect.stringMatching(/USD/) });
  });

  it("months: Zoho's taxable, heads, ITC (eligible), RCM and TDS vs what will come in", () => {
    const p = buildPurchasePlan([
      bill(),
      bill({ zohoId: "B2", date: "2025-05-20", tdsAmount: 100, tdsSection: "194J", lines: [line({ itcEligible: false })] }),
      bill({ zohoId: "B3", status: "void" }),
    ], ctx());
    expect(p.zohoByMonth).toEqual([{ month: "2025-05", count: 2, taxable: 2000, igst: 0, cgst: 180, sgst: 180, itc: 180, rcmTax: 0, tds: 100 }]);
    expect(p.importByMonth).toEqual(p.zohoByMonth);
    expect(p.tdsBySection).toEqual([{ section: "194J", amount: 100, count: 1 }]);
  });
});

describe("buildPaymentPlan — vendor payments onto imported bills", () => {
  const pay = (over: Partial<VendorPaymentFacts> = {}): VendorPaymentFacts => ({
    kind: "vendorpayments", zohoId: "P1", number: "7", date: "2025-06-01", status: "", vendorZohoId: "V1", vendorName: "Mehta Cloud",
    currency: "INR", amount: 1180, unapplied: 0, paidThrough: "HDFC 4523", mode: "Bank Transfer", reference: "UTR1",
    applied: [{ billZohoId: "B1", billNumber: "VB-1", amount: 1180 }], problems: [], ...over,
  });
  const pctx = { fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
    targets: new Map([["B1", { type: "expense" as const }], ["BC", { type: "vendor_bill" as const }]]), importedPayments: new Set<string>(),
    bills: new Map([["B1", { total: 1180, tds: 0, tdsSection: null }], ["BC", { total: 2360, tds: 200, tdsSection: "194C" }]]),
    bankAccounts: ACCOUNTS, accountMap: {} as Record<string, string> };

  it("onto an imported expense bill: import; listed by paid-through account", () => {
    const p = buildPaymentPlan([pay()], pctx);
    expect(p.rows[0]).toMatchObject({ verdict: "import", accountId: "acc-4523" });
    expect(p.accounts).toEqual([{ zohoName: "HDFC 4523", count: 1, amount: 1180, appAccountId: "acc-4523", suggested: true }]);
  });
  it("onto a COGS bill only: not booked here (no manual bank line) — listed to pay in Reconcile", () => {
    const p = buildPaymentPlan([pay({ applied: [{ billZohoId: "BC", billNumber: "C-1", amount: 500 }], amount: 500 })], pctx);
    expect(p.rows[0]).toMatchObject({ verdict: "skip", reason: expect.stringMatching(/Reconcile/) });
    expect(p.counts.cogsAmount).toBe(500);
    expect(p.toReconcile).toEqual([{ why: "cogs", number: "7", date: "2025-06-01", vendor: "Mehta Cloud", bill: "C-1", amount: 500, tds: 200, tdsSection: "194C" }]);
  });
  it("a payment on an expense bill AND a COGS bill: the expense part comes in, the COGS part is listed", () => {
    const p = buildPaymentPlan([pay({ amount: 1680, applied: [{ billZohoId: "B1", billNumber: "VB-1", amount: 1180 }, { billZohoId: "BC", billNumber: "C-1", amount: 500 }] })], pctx);
    expect(p.rows[0].verdict).toBe("import");
    expect(p.counts).toMatchObject({ amount: 1180, cogsAmount: 500 });
  });
  it("bill not imported yet → left out, says import bills first", () => {
    const p = buildPaymentPlan([pay({ applied: [{ billZohoId: "NOPE", billNumber: "X", amount: 5 }] })], pctx);
    expect(p.rows[0]).toMatchObject({ verdict: "skip", reason: expect.stringMatching(/Import the bills first/) });
  });
  it("an advance (nothing applied) → left out and its amount reported", () => {
    const p = buildPaymentPlan([pay({ applied: [], unapplied: 1180 })], pctx);
    expect(p.rows[0].verdict).toBe("skip");
    expect(p.counts.advanceAmount).toBe(1180);
  });
  it("already imported → already", () => {
    expect(buildPaymentPlan([pay()], { ...pctx, importedPayments: new Set(["P1"]) }).rows[0].verdict).toBe("already");
  });
});

describe("review fixes", () => {
  it("a two-category IGST bill: each row's claimable GST gets the IGST head (not an assumed CGST/SGST split)", () => {
    const f = bill({ igst: 180, cgst: 0, sgst: 0, lines: [line({ taxable: 500, tax: 90 }), line({ accountId: "A2", taxable: 500, tax: 90 })] });
    const legs = legsOf(f, { A1: "Software", A2: "Internet & Phone" });
    expect(legs.map((l) => l.heads)).toEqual([{ igst: 90, cgst: 0, sgst: 0 }, { igst: 90, cgst: 0, sgst: 0 }]);
  });
  it("an intra-state bill with an ineligible line: heads on the claimable part only", () => {
    const f = bill({ lines: [line({ taxable: 500, tax: 90 }), line({ accountId: "A2", taxable: 500, tax: 90, itcEligible: false })] });
    expect(legsOf(f, { A1: "Software", A2: "Staff Welfare" }).map((l) => l.heads)).toEqual([{ igst: 0, cgst: 45, sgst: 45 }, { igst: 0, cgst: 0, sgst: 0 }]);
  });
  it("a void payment's unapplied balance is not an advance to book", () => {
    const p = buildPaymentPlan([{ kind: "vendorpayments", zohoId: "PV", number: "9", date: "2025-06-01", status: "void", vendorZohoId: "V", vendorName: "X",
      currency: "INR", amount: 50000, unapplied: 50000, paidThrough: "", mode: "", reference: "", applied: [], problems: [] }],
    { fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null, targets: new Map(), importedPayments: new Set() });
    expect(p.counts.advanceAmount).toBe(0);
  });
});

describe("independent-review fixes (R-2502c)", () => {
  const pay = (over: Partial<VendorPaymentFacts> = {}): VendorPaymentFacts => ({
    kind: "vendorpayments", zohoId: "P1", number: "7", date: "2025-06-01", status: "", vendorZohoId: "V1", vendorName: "Mehta Cloud",
    currency: "INR", amount: 1180, unapplied: 0, paidThrough: "HDFC 4523", mode: "Bank Transfer", reference: "UTR1",
    applied: [{ billZohoId: "B1", billNumber: "VB-1", amount: 1180 }], problems: [], ...over,
  });
  const pctx = { fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
    targets: new Map([["B1", { type: "expense" as const }], ["BC", { type: "vendor_bill" as const }]]), importedPayments: new Set<string>(),
    bills: new Map([["B1", { total: 1180, tds: 0, tdsSection: null as string | null }]]),
    bankAccounts: ACCOUNTS, accountMap: {} as Record<string, string> };
  it("never name-matches a vendor whose GSTIN differs — creates a new one", () => {
    const p = buildPurchasePlan([bill({ gstin: "29AAACM1234A1Z5" })], ctx());
    expect(p.rows[0]).toMatchObject({ verdict: "import", vendorId: null, createVendor: true });
  });
  it("name-matches a vendor with no GSTIN, or the same GSTIN", () => {
    expect(buildPurchasePlan([bill({ gstin: "29AAACM1234A1Z5" })], ctx({ vendors: [{ id: "v0", name: "Mehta Cloud", gstin: null, zohoContactId: null }] })).rows[0].vendorId).toBe("v0");
    expect(buildPurchasePlan([bill({ gstin: "" })], ctx()).rows[0].vendorId).toBe("v-mehta");
  });
  it("a Zoho expense needs the app account its paid-through account maps to (suggested by last 4 digits / petty cash)", () => {
    const e = (paidThrough: string, zohoId = "E1") => bill({ kind: "expenses", zohoId, number: "", paidThrough });
    const p = buildPurchasePlan([e("HDFC Bank 4523"), e("Petty Cash", "E2"), e("Director - Rakesh", "E3")], ctx());
    expect(p.rows.map((r) => [r.verdict, r.accountId])).toEqual([["import", "acc-4523"], ["import", "acc-cash"], ["skip", null]]);
    expect(p.rows[2].reason).toMatch(/Choose the app account for Zoho's "Director - Rakesh"/);
    expect(toPurchasePick(p.rows[1])).toEqual({ kind: "expenses", zoho_id: "E2", vendor_id: "v-mehta", account_id: "acc-cash" });
    expect(p.accounts.find((a) => a.zohoName === "Director - Rakesh")).toMatchObject({ appAccountId: null });
    const mapped = buildPurchasePlan([e("Director - Rakesh", "E3")], ctx({ accountMap: { "Director - Rakesh": "acc-4523" } }));
    expect(mapped.rows[0]).toMatchObject({ verdict: "import", accountId: "acc-4523" });
  });
  it("an account that is not this company's is ignored (falls back to unmapped)", () => {
    const p = buildPurchasePlan([bill({ kind: "expenses", paidThrough: "Card X" })], ctx({ accountMap: { "Card X": "someone-else" } }));
    expect(p.rows[0].verdict).toBe("skip");
  });
  it("an expense bill paid in 2 Zoho payments: never marked paid — each payment listed to pay in Reconcile (TDS with the first)", () => {
    const bills = new Map([["B1", { total: 1180, tds: 100, tdsSection: "194JB" }]]);
    const p1 = pay({ zohoId: "P1", number: "1", date: "2025-06-01", amount: 500, applied: [{ billZohoId: "B1", billNumber: "VB-1", amount: 500 }] });
    const p2 = pay({ zohoId: "P2", number: "2", date: "2025-07-01", amount: 580, applied: [{ billZohoId: "B1", billNumber: "VB-1", amount: 580 }] });
    const p = buildPaymentPlan([p2, p1], { ...pctx, bills });
    expect(p.rows.map((r) => r.verdict)).toEqual(["skip", "skip"]);
    expect(p.rows[0].reason).toMatch(/2 payments/);
    expect(p.toReconcile).toEqual([
      { why: "parts", number: "1", date: "2025-06-01", vendor: "Mehta Cloud", bill: "VB-1", amount: 500, tds: 100, tdsSection: "194JB" },
      { why: "parts", number: "2", date: "2025-07-01", vendor: "Mehta Cloud", bill: "VB-1", amount: 580, tds: 0, tdsSection: null },
    ]);
  });
  it("one payment that does not cover the bill: listed too (not marked paid)", () => {
    const p = buildPaymentPlan([pay({ amount: 300, applied: [{ billZohoId: "B1", billNumber: "VB-1", amount: 300 }] })], pctx);
    expect(p.rows[0].verdict).toBe("skip");
    expect(p.toReconcile[0]).toMatchObject({ why: "parts", amount: 300 });
  });
  it("a payment whose paid-through account is not mapped is left out (never a blank method)", () => {
    const p = buildPaymentPlan([pay({ paidThrough: "Amex Card" })], pctx);
    expect(p.rows[0]).toMatchObject({ verdict: "skip", reason: expect.stringMatching(/Choose the app account for Zoho's "Amex Card"/) });
  });
});

describe("R-2502c — a card account is suggested by its last 4 digits", () => {
  it("Zoho 'HDFC Credit Card 9911' → the app card account ··9911", () => {
    const card = { id: "acc-card", name: "Business Card", bank_name: "HDFC", account_number_last4: "9911", account_type: "credit_card", is_active: true, is_default_petty_cash: false };
    const q = buildPurchasePlan([{ kind: "expenses", zohoId: "E9", number: "", date: "2025-05-10", dueDate: null, status: "nonbillable", vendorZohoId: "V1",
      vendorName: "Mehta Cloud", gstin: "", gstTreatment: "", currency: "INR", taxable: 100, igst: 0, cgst: 0, sgst: 0, tax: 0, total: 100, rcm: false, rcmTax: 0,
      tdsAmount: 0, tdsSection: null, lines: [{ accountId: "A1", accountName: "Software", description: "", hsn: "", qty: 1, taxable: 100, tax: 0, itcEligible: true }],
      paidThrough: "HDFC Credit Card 9911", problems: [] }], ctx({ bankAccounts: [...ACCOUNTS, card] }));
    expect(q.rows[0]).toMatchObject({ verdict: "import", accountId: "acc-card" });
  });
});
