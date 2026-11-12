/**
 * R-2702 (G-FY2526) — Zoho FY 2025-26 invoices that were left out now come in as Zoho filed them:
 *   (1) TDS on the invoice (36 on staging Excel): the SALE is taxable + GST at full value; the TDS is the
 *       customer's deduction, kept on the facts (tds / tdsSection) for the receipt — never a sale reduction.
 *       Zoho's own total is net of that TDS (taxable + GST − TDS); a total that already is the full value
 *       (TDS shown but not taken off) is read too. Which one is told by the lines, else by the GST rate.
 *   (2) A Zoho adjustment (16): a visible "Adjustment" line with no GST; taxable and GST stay Zoho's, the
 *       total equals Zoho's.
 *   (3) Lines at different GST rates (7): each line keeps its own rate; the invoice carries the highest.
 * Zoho is never called: details are Zoho-shaped (fy-fetch ZohoFyDocDetail). Names and figures are made up
 * in the shape of INV/25-26/0696 (TDS), 0065 (adjustment), 1248 (0% + 18%).
 */
import { describe, it, expect } from "vitest";
import type { ZohoFyDocDetail } from "../fy-fetch";
import { zohoSaleFacts } from "./normalise";
import { buildSalesPlan, type PlanContext } from "./plan";

const SELLER = "07";

function detail(over: Partial<ZohoFyDocDetail> & { rawOver?: Record<string, unknown> } = {}): ZohoFyDocDetail {
  const { rawOver, ...rest } = over;
  const base: ZohoFyDocDetail = {
    kind: "invoices",
    id: "9002702",
    number: "INV/25-26/0696",
    date: "2025-08-12",
    status: "paid",
    contactId: "c-1",
    contactName: "Delhi Buyer",
    totalPaise: 1_08_000_00,       // ₹1,00,000 + 18% GST − 10% TDS on ₹1,00,000 = ₹1,08,000 (Zoho's net total)
    balancePaise: 0,
    currency: "INR",
    raw: { line_items: [{ item_id: "z-1", name: "Cloud Seat Plan", rate: 1000 }], due_date: "2025-08-27",
      tds_tax_name: "Professional Fees [10%] - 194 J", tds_amount: 10000 },
    lines: [{ accountId: "a1", accountName: "Sales", description: "100 seats", hsnOrSac: "998315", quantity: 100, amountPaise: 1_00_000_00, taxId: "g", taxName: "GST18", taxPercent: 18 }],
    taxes: [{ name: "CGST9", amountPaise: 9_000_00 }, { name: "SGST9", amountPaise: 9_000_00 }],
    taxTotalPaise: 18_000_00,
    tdsPaise: 10_000_00,
    gstNo: "07ABCDE1234F1Z5",
    gstTreatment: "business_gst",
    placeOfSupply: "DL",
    reverseCharge: false,
  };
  return { ...base, ...rest, raw: { ...base.raw, ...(rest.raw ?? {}), ...(rawOver ?? {}) } };
}

const ctx: PlanContext = {
  fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
  customers: [{ id: "cust-dl", name: "Delhi Buyer", gstin: "07ABCDE1234F1Z5" }],
  items: [], invoices: [],
};

describe("R-2702 (1) TDS on the invoice in Zoho", () => {
  it("is a sale at full value: taxable + GST = amount; the TDS is kept for the receipt", () => {
    const f = zohoSaleFacts(detail(), SELLER);
    expect(f.problems).toEqual([]);
    expect(f.taxable).toBe(100000);
    expect(f.tax).toBe(18000);
    expect(f.amount).toBe(118000);           // never 1,08,000 — TDS is not a sale reduction
    expect(f.roundOff).toBe(0);
    expect(f.tds).toBe(10000);
    expect(f.tdsSection).toBe("194JB");      // "Professional Fees … 194 J" → 194JB (purchase-import rule)
    expect(f.notes.join(" ")).toMatch(/TDS ₹10000 .*receipt/);
  });

  it("is imported by the plan (no longer left out)", () => {
    const p = buildSalesPlan([zohoSaleFacts(detail(), SELLER)], ctx);
    expect(p.rows[0].verdict).toBe("import");
    expect(p.importByMonth[0].amount).toBe(118000);
  });

  it("a Zoho total that already is the full value (TDS not taken off) is not grossed up twice", () => {
    const f = zohoSaleFacts(detail({ totalPaise: 1_18_000_00 }), SELLER);
    expect(f.problems).toEqual([]);
    expect(f.taxable).toBe(100000);
    expect(f.amount).toBe(118000);
    expect(f.tds).toBe(10000);
  });

  it("with no lines to read, the GST rate tells net from full", () => {
    const f = zohoSaleFacts(detail({ lines: [], rawOver: { line_items: [] } }), SELLER);
    expect(f.problems).toEqual([]);
    expect(f.taxable).toBe(100000);
    expect(f.amount).toBe(118000);
  });

  it("a total that fits neither reading is refused with the figures", () => {
    const f = zohoSaleFacts(detail({ totalPaise: 1_12_000_00 }), SELLER);
    expect(f.problems.join(" ")).toMatch(/TDS ₹10000/);
  });

  it("TDS with no readable section: section null (the receipt's own default applies), still imported", () => {
    const f = zohoSaleFacts(detail({ rawOver: { tds_tax_name: "" } }), SELLER);
    expect(f.problems).toEqual([]);
    expect(f.tdsSection).toBeNull();
  });

  it("TDS on a foreign-currency invoice is refused (a foreign buyer deducts no Indian TDS)", () => {
    const f = zohoSaleFacts(detail({ currency: "USD", rawOver: { exchange_rate: 85 } }), SELLER);
    expect(f.problems.join(" ")).toMatch(/TDS on a USD invoice/);
  });

  it("an invoice without TDS has tds 0", () => {
    const f = zohoSaleFacts(detail({ tdsPaise: 0, totalPaise: 1_18_000_00 }), SELLER);
    expect(f.tds).toBe(0);
    expect(f.tdsSection).toBeNull();
    expect(f.amount).toBe(118000);
  });
});

describe("R-2702 (2) a Zoho adjustment", () => {
  const adj = (adjustment: number, totalPaise: number, description = "Discount on renewal") => detail({
    number: "INV/25-26/0065", tdsPaise: 0, totalPaise,
    rawOver: { tds_amount: 0, tds_tax_name: "", adjustment, adjustment_description: description },
  });

  it("a −₹250 adjustment becomes a visible no-GST line; taxable and GST stay Zoho's; total = Zoho's", () => {
    const f = zohoSaleFacts(adj(-250, 1_17_750_00), SELLER);
    expect(f.problems).toEqual([]);
    expect(f.taxable).toBe(100000);
    expect(f.tax).toBe(18000);
    expect(f.amount).toBe(117750);
    expect(f.adjustment).toBe(-250);
    expect(f.roundOff).toBe(-250);           // amount − taxable − GST, as the SQL checks
    const last = f.lines[f.lines.length - 1];
    expect(last).toMatchObject({ kind: "adjustment", name: "Discount on renewal", qty: 1, rate: -250, taxable: -250, taxPercent: null, hsn: "" });
    expect(f.taxRate).toBe(18);              // the adjustment line never makes it "mixed"
    expect(buildSalesPlan([f], ctx).rows[0].verdict).toBe("import");
  });

  it("the adjustment line is never matched to a catalogue item, even one named 'Adjustment'", () => {
    const f = zohoSaleFacts(adj(500, 1_18_500_00, ""), SELLER);
    const p = buildSalesPlan([f], { ...ctx, items: [{ id: "ITEM-ADJ", name: "Adjustment" }, { id: "ITEM-CSP", name: "Cloud Seat Plan" }] });
    expect(p.rows[0].itemIds).toEqual(["ITEM-CSP", null]);
  });

  it("a +₹500 adjustment with no description is named 'Adjustment'", () => {
    const f = zohoSaleFacts(adj(500, 1_18_500_00, ""), SELLER);
    expect(f.problems).toEqual([]);
    expect(f.amount).toBe(118500);
    expect(f.adjustment).toBe(500);
    expect(f.lines[f.lines.length - 1]).toMatchObject({ kind: "adjustment", name: "Adjustment" });
  });

  it("a round-off under one unit stays a round-off (R-2650), no line", () => {
    const f = zohoSaleFacts(adj(0.4, 1_18_000_40), SELLER);
    expect(f.adjustment).toBe(0);
    expect(f.lines.some((l) => l.kind === "adjustment")).toBe(false);
  });
});

describe("R-2702 (3) lines at different GST rates", () => {
  const mixed = (over: Partial<ZohoFyDocDetail> = {}) => detail({
    number: "INV/25-26/1248", tdsPaise: 0, totalPaise: 1_16_200_00, // ₹90,000 @18% + ₹10,000 @0% → GST ₹16,200
    rawOver: { tds_amount: 0, tds_tax_name: "" },
    lines: [
      { accountId: "a1", accountName: "Sales", description: "seats", hsnOrSac: "998315", quantity: 1, amountPaise: 90_000_00, taxId: "g", taxName: "GST18", taxPercent: 18 },
      { accountId: "a1", accountName: "Sales", description: "govt fee", hsnOrSac: "998599", quantity: 1, amountPaise: 10_000_00, taxId: "z", taxName: "GST0", taxPercent: 0 },
    ],
    taxes: [{ name: "CGST9", amountPaise: 8_100_00 }, { name: "SGST9", amountPaise: 8_100_00 }],
    taxTotalPaise: 16_200_00,
    ...over,
  });

  it("imports one invoice; each line keeps its rate; the invoice carries the highest", () => {
    const f = zohoSaleFacts(mixed({ totalPaise: 1_16_200_00 }), SELLER);
    expect(f.problems).toEqual([]);
    expect(f.taxable).toBe(100000);
    expect(f.tax).toBe(16200);
    expect(f.amount).toBe(116200);
    expect(f.taxRate).toBe(18);
    expect(f.lines.map((l) => l.taxPercent)).toEqual([18, 0]);
    expect(f.notes.join(" ")).toMatch(/0%, 18%/);
    expect(buildSalesPlan([f], ctx).rows[0].verdict).toBe("import");
  });

  it("GST that is not the lines' own rates is still refused", () => {
    const f = zohoSaleFacts(mixed({ totalPaise: 1_18_000_00, taxTotalPaise: 18_000_00,
      taxes: [{ name: "CGST9", amountPaise: 9_000_00 }, { name: "SGST9", amountPaise: 9_000_00 }] }), SELLER);
    expect(f.problems.join(" ")).toMatch(/different GST rates/);
  });

  it("a line rate this app does not store is refused", () => {
    const f = zohoSaleFacts(mixed({ totalPaise: 1_16_200_00 + 25_00, taxTotalPaise: 16_225_00,
      taxes: [{ name: "IGST", amountPaise: 16_225_00 }],
      lines: [
        { accountId: "a1", accountName: "Sales", description: "seats", hsnOrSac: "998315", quantity: 1, amountPaise: 90_000_00, taxId: "g", taxName: "GST18", taxPercent: 18 },
        { accountId: "a1", accountName: "Sales", description: "odd", hsnOrSac: "998599", quantity: 1, amountPaise: 10_000_00, taxId: "z", taxName: "GST0.25", taxPercent: 0.25 },
      ] }), SELLER);
    expect(f.problems.length).toBeGreaterThan(0);
  });
});
