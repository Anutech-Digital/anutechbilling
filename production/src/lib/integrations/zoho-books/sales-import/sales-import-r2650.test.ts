/**
 * R-2650 (G-FY2526) — the FY 2025-26 Zoho sales import refused 22 of Zoho's own filed invoices with
 * "Taxable, GST and total do not add up". The taxable is total − GST − Zoho's round-off/adjustment,
 * so a ₹ invoice adds up by construction; a FOREIGN-currency invoice's round-off (allowed up to one
 * unit of its currency) was multiplied by the rate and broke the SQL's ₹1 rule. These fixtures are
 * Zoho-shaped invoice details (names made up); Zoho is never called.
 */
import { describe, it, expect } from "vitest";
import type { ZohoFyDocDetail } from "../fy-fetch";
import { roundOffLimit, zohoSaleFacts, type ZohoSaleFacts } from "./normalise";

const SELLER = "07"; // Delhi

function detail(over: Partial<ZohoFyDocDetail> & { rawOver?: Record<string, unknown> } = {}): ZohoFyDocDetail {
  const { rawOver, ...rest } = over;
  const base: ZohoFyDocDetail = {
    kind: "invoices",
    id: "9100001",
    number: "INV/25-26/0949",
    date: "2025-07-14",
    status: "paid",
    contactId: "c-1",
    contactName: "Test Buyer Pvt Ltd",
    totalPaise: 1_18_000_00,
    balancePaise: 0,
    currency: "INR",
    raw: { line_items: [{ item_id: "z-1", name: "Cloud Seat Plan", rate: 1000 }], due_date: "2025-07-29" },
    lines: [{ accountId: "a1", accountName: "Sales", description: "", hsnOrSac: "998315", quantity: 100, amountPaise: 1_00_000_00, taxId: "t1", taxName: "IGST18", taxPercent: 18 }],
    taxes: [{ name: "IGST18", amountPaise: 18_000_00 }],
    taxTotalPaise: 18_000_00,
    tdsPaise: 0,
    gstNo: "29ABCDE1234F1Z5",
    gstTreatment: "business_gst",
    placeOfSupply: "KA",
    reverseCharge: false,
  };
  return { ...base, ...rest, raw: { ...base.raw, ...(rest.raw ?? {}), ...(rawOver ?? {}) } };
}

/** The SQL import's rule (import_zoho_fy_sales, R-2650): what it accepts, mirrored for the test. */
function sqlAccepts(f: ZohoSaleFacts): boolean {
  const gap = f.amount - f.taxable - f.tax;
  const limit = (f.currency === "INR" || !f.fxRate ? 1 : Math.ceil(f.fxRate)) + 1;
  return f.taxable >= 0 && f.tax >= 0 && f.amount > 0 && Math.abs(gap) <= limit;
}

/** A USD export with IGST paid (Zoho's "overseas", 18%): $1,234.45 + $222.20 GST, total rounded to $1,457. */
const usd = (rawOver: Record<string, unknown> = {}) => detail({
  currency: "USD",
  gstNo: "", gstTreatment: "overseas", placeOfSupply: "",
  totalPaise: 1457_00,
  taxTotalPaise: 222_20,
  taxes: [{ name: "IGST18", amountPaise: 222_20 }],
  lines: [{ accountId: "a1", accountName: "Sales", description: "", hsnOrSac: "998315", quantity: 1, amountPaise: 1234_45, taxId: "t1", taxName: "IGST18", taxPercent: 18 }],
  rawOver: { exchange_rate: 85.12, roundoff_value: 0.35, ...rawOver },
});

describe("R-2650 foreign-currency round-off — imported as Zoho filed it", () => {
  it("USD round-off ($0.35 × 85.12 ≈ ₹30) no longer breaks the ₹ check (the 22 refused invoices)", () => {
    const f = zohoSaleFacts(usd(), SELLER);
    expect(f.problems).toEqual([]);
    expect(f.amount).toBe(Math.round(1457 * 85.12));          // 124020
    expect(f.tax).toBe(Math.round(222.20 * 85.12));           // 18914
    expect(f.taxable).toBe(Math.round((1457 - 222.20 - 0.35) * 85.12)); // 105077
    expect(f.roundOff).toBe(f.amount - f.taxable - f.tax);
    expect(Math.abs(f.roundOff)).toBeGreaterThan(1);           // the old ₹1 rule refused exactly this
    expect(sqlAccepts(f)).toBe(true);
  });

  it("uses Zoho's own base-currency (₹) totals when Zoho sends them — never re-computed", () => {
    const f = zohoSaleFacts(usd({ bcy_total: 124019.84, bcy_tax_total: 18913.66, bcy_adjustment: 0, bcy_roundoff_value: 29.79 }), SELLER);
    expect(f.amount).toBe(124020);
    expect(f.tax).toBe(18914);
    expect(f.taxable).toBe(Math.round(124019.84 - 18913.66 - 29.79)); // 105076
    expect(f.roundOff).toBe(124020 - 105076 - 18914);
    expect(f.problems).toEqual([]);
    expect(sqlAccepts(f)).toBe(true);
  });

  it("a 0% export in USD with a round-off adds up too (the LUT rule is a separate gate)", () => {
    const f = zohoSaleFacts(detail({
      currency: "USD", gstNo: "", gstTreatment: "overseas", placeOfSupply: "",
      totalPaise: 980_00, taxTotalPaise: 0, taxes: [],
      lines: [{ accountId: "a1", accountName: "Sales", description: "", hsnOrSac: "998315", quantity: 1, amountPaise: 979_60, taxId: "", taxName: "", taxPercent: 0 }],
      rawOver: { exchange_rate: 86.4, roundoff_value: 0.4 },
    }), SELLER);
    expect(f.problems).toEqual([]);
    expect(f.taxRate).toBe(0);
    expect(f.amount).toBe(Math.round(980 * 86.4));
    expect(f.taxable).toBe(Math.round(979.6 * 86.4));
    expect(sqlAccepts(f)).toBe(true);
  });

  it("a round-off above one unit of the invoice's currency is still refused", () => {
    const f = zohoSaleFacts(usd({ roundoff_value: 0, adjustment: 1.5 }), SELLER);
    expect(f.problems.join(" ")).toMatch(/adjustment/);
  });

  it("roundOffLimit: one unit of the invoice's currency in ₹, + ₹1 for rounding each figure once", () => {
    expect(roundOffLimit("INR", null)).toBe(2);
    expect(roundOffLimit("USD", 85.12)).toBe(87);
    expect(roundOffLimit("USD", null)).toBe(2);
  });
});

describe("R-2650 ₹ shapes Zoho files — they add up and import", () => {
  it("a ₹1.00 adjustment on a total with paise: gap ₹2 after rounding each figure once — still Zoho's own split", () => {
    // total 1000.50 → ₹1,001, GST 152.30 → ₹152, taxable 1000.50 − 152.30 − 1.00 = 847.20 → ₹847
    const f = zohoSaleFacts(detail({ totalPaise: 1000_50, taxTotalPaise: 152_30, taxes: [{ name: "IGST18", amountPaise: 152_30 }],
      lines: [{ accountId: "a1", accountName: "Sales", description: "", hsnOrSac: "998315", quantity: 1, amountPaise: 847_20, taxId: "t", taxName: "IGST18", taxPercent: 18 }],
      rawOver: { adjustment: 1 } }), SELLER);
    expect(f.roundOff).toBe(2);
    expect(f.problems).toEqual([]);
    expect(sqlAccepts(f)).toBe(true);
  });

  it("round-off to the rupee (total ₹1,180, GST ₹180.06, round-off −₹0.40)", () => {
    const f = zohoSaleFacts(detail({ totalPaise: 1180_00, taxTotalPaise: 180_06, taxes: [{ name: "IGST18", amountPaise: 180_06 }],
      lines: [{ accountId: "a1", accountName: "Sales", description: "", hsnOrSac: "998315", quantity: 1, amountPaise: 1000_34, taxId: "t", taxName: "IGST18", taxPercent: 18 }],
      rawOver: { roundoff_value: -0.4 } }), SELLER);
    expect(f.problems).toEqual([]);
    expect(f.roundOff).toBe(f.amount - f.taxable - f.tax);
    expect(sqlAccepts(f)).toBe(true);
  });

  it("GST rounded per line (3 lines × ₹33.33 at 18%) — Zoho's GST total kept, not re-computed", () => {
    const line = { accountId: "a1", accountName: "Sales", description: "", hsnOrSac: "998315", quantity: 1, amountPaise: 33_33, taxId: "t", taxName: "IGST18", taxPercent: 18 };
    const f = zohoSaleFacts(detail({ totalPaise: 117_99, taxTotalPaise: 18_00, taxes: [{ name: "IGST18", amountPaise: 18_00 }], lines: [line, line, line] }), SELLER);
    expect(f.tax).toBe(18);
    expect(f.taxable).toBe(100);
    expect(f.problems).toEqual([]);
    expect(sqlAccepts(f)).toBe(true);
  });

  it("discount before tax + shipping with GST: taxable = what Zoho filed (lines − discount + shipping)", () => {
    // lines ₹10,000 − 10% discount = ₹9,000 + shipping ₹500 = ₹9,500 taxable; GST 18% = ₹1,710
    const f = zohoSaleFacts(detail({ totalPaise: 11_210_00, taxTotalPaise: 1_710_00, taxes: [{ name: "IGST18", amountPaise: 1_710_00 }],
      lines: [{ accountId: "a1", accountName: "Sales", description: "", hsnOrSac: "998315", quantity: 10, amountPaise: 10_000_00, taxId: "t", taxName: "IGST18", taxPercent: 18 }],
      rawOver: { discount: 10, discount_amount: 1000, is_discount_before_tax: true, shipping_charge: 500 } }), SELLER);
    expect(f.taxable).toBe(9500);
    expect(f.tax).toBe(1710);
    expect(f.amount).toBe(11210);
    expect(f.problems).toEqual([]);
    expect(sqlAccepts(f)).toBe(true);
  });

  it("tax-inclusive prices (₹1,180 incl. 18%)", () => {
    const f = zohoSaleFacts(detail({ totalPaise: 1180_00, taxTotalPaise: 180_00, taxes: [{ name: "IGST18", amountPaise: 180_00 }],
      lines: [{ accountId: "a1", accountName: "Sales", description: "", hsnOrSac: "998315", quantity: 1, amountPaise: 1180_00, taxId: "t", taxName: "IGST18", taxPercent: 18 }],
      rawOver: { is_inclusive_tax: true } }), SELLER);
    expect(f.taxable).toBe(1000);
    expect(f.problems).toEqual([]);
    expect(sqlAccepts(f)).toBe(true);
  });
});

describe("R-2650 genuinely broken data is still refused", () => {
  it("Zoho's GST heads do not add up to its GST total", () => {
    const f = zohoSaleFacts(detail({ taxes: [{ name: "IGST18", amountPaise: 17_000_00 }] }), SELLER);
    expect(f.problems.join(" ")).toMatch(/GST heads .* do not add up to its GST/);
  });

  it("TCS collected on the invoice would sit inside the taxable — refused", () => {
    const f = zohoSaleFacts(detail({ totalPaise: 1_18_100_00, rawOver: { tcs_amount: 100 } }), SELLER);
    expect(f.problems.join(" ")).toMatch(/TCS/);
  });

  it("adjustment above ₹1, TDS, discount after tax, mixed rates — unchanged reasons", () => {
    expect(zohoSaleFacts(detail({ totalPaise: 1_18_500_00, rawOver: { adjustment: 500 } }), SELLER).problems.join(" ")).toMatch(/adjustment of ₹500/);
    expect(zohoSaleFacts(detail({ tdsPaise: 10_000_00 }), SELLER).problems.join(" ")).toMatch(/TDS/);
    expect(zohoSaleFacts(detail({ rawOver: { discount_amount: 100, is_discount_before_tax: false } }), SELLER).problems.join(" ")).toMatch(/Discount after tax/);
    const mixed = zohoSaleFacts(detail({ lines: [
      { accountId: "a", accountName: "S", description: "", hsnOrSac: "", quantity: 1, amountPaise: 50_000_00, taxId: "", taxName: "IGST18", taxPercent: 18 },
      { accountId: "a", accountName: "S", description: "", hsnOrSac: "", quantity: 1, amountPaise: 50_000_00, taxId: "", taxName: "IGST5", taxPercent: 5 },
    ] }), SELLER);
    expect(mixed.problems.join(" ")).toMatch(/different GST rates/);
  });

});
