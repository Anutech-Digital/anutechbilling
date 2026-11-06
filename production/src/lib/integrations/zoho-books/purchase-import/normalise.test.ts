/**
 * R-2502 — Zoho bills / expenses / vendor payments (R-2498 fetchers, money in PAISE) → facts in
 * WHOLE RUPEES, once. GST heads, ITC eligibility per line, RCM, TDS by section, void / draft.
 * No Zoho call: the details below are what getFyDocDetail returns.
 */
import { describe, it, expect } from "vitest";
import { zohoPurchaseFacts, zohoVendorPaymentFacts, tdsSectionOf } from "./normalise";
import type { ZohoFyDocDetail } from "../fy-fetch";

function detail(over: Partial<ZohoFyDocDetail> & { raw?: Record<string, unknown> } = {}): ZohoFyDocDetail {
  return {
    kind: "bills", id: "B1", number: "VB-1", date: "2025-05-10", status: "open",
    contactId: "V1", contactName: "Mehta Cloud", totalPaise: 1_180_00, balancePaise: 1_180_00, currency: "INR",
    raw: { due_date: "2025-06-09", sub_total: 1000, tax_total: 180, total: 1180 },
    lines: [{ accountId: "A1", accountName: "Software", description: "Licence", hsnOrSac: "998431", quantity: 1, amountPaise: 1_000_00, taxId: "t", taxName: "GST18", taxPercent: 18 }],
    taxes: [{ name: "CGST9", amountPaise: 90_00 }, { name: "SGST9", amountPaise: 90_00 }],
    taxTotalPaise: 180_00, tdsPaise: 0, gstNo: "07AAACM1234A1Z5", gstTreatment: "business_gst", placeOfSupply: "DL", reverseCharge: false,
    ...over,
  };
}

describe("zohoPurchaseFacts — paise → whole rupees, GST heads", () => {
  it("a CGST + SGST bill: taxable, heads and total in rupees", () => {
    const f = zohoPurchaseFacts(detail());
    expect(f).toMatchObject({ kind: "bills", zohoId: "B1", number: "VB-1", date: "2025-05-10", dueDate: "2025-06-09", status: "open",
      vendorZohoId: "V1", vendorName: "Mehta Cloud", gstin: "07AAACM1234A1Z5", taxable: 1000, cgst: 90, sgst: 90, igst: 0, tax: 180, total: 1180,
      rcm: false, tdsAmount: 0, tdsSection: null, problems: [] });
    expect(f.lines).toEqual([expect.objectContaining({ accountId: "A1", accountName: "Software", taxable: 1000, tax: 180, itcEligible: true, hsn: "998431" })]);
  });

  it("IGST bill; paise rounded once (taxable 999.60 → 1000, IGST 179.93 → 180)", () => {
    const f = zohoPurchaseFacts(detail({
      totalPaise: 1_179_53, taxTotalPaise: 179_93, taxes: [{ name: "IGST18", amountPaise: 179_93 }],
      lines: [{ ...detail().lines[0], amountPaise: 999_60 }],
    }));
    expect(f).toMatchObject({ taxable: 1000, igst: 180, cgst: 0, sgst: 0, tax: 180 });
    expect(f.lines[0].taxable).toBe(1000);
  });

  it("lines add up to the taxable after rounding (last line takes the difference)", () => {
    const l = detail().lines[0];
    const f = zohoPurchaseFacts(detail({ lines: [{ ...l, amountPaise: 333_33 }, { ...l, amountPaise: 333_33 }, { ...l, amountPaise: 333_34 }] }));
    expect(f.lines.map((x) => x.taxable).reduce((a, b) => a + b, 0)).toBe(f.taxable);
    expect(f.lines.map((x) => x.tax).reduce((a, b) => a + b, 0)).toBe(f.tax);
  });

  it("ITC ineligible line (s.17(5)) is marked, with its GST share", () => {
    const l = detail().lines[0];
    const f = zohoPurchaseFacts(detail({
      raw: { line_items: [{ itc_eligibility: "eligible" }, { itc_eligibility: "ineligible_section17" }] },
      lines: [{ ...l, amountPaise: 500_00 }, { ...l, accountId: "A2", accountName: "Staff Welfare", amountPaise: 500_00 }],
    }));
    expect(f.lines.map((x) => x.itcEligible)).toEqual([true, false]);
    expect(f.lines[1].tax).toBe(90);
  });

  it("reverse charge: no GST charged by the vendor, the RCM tax is carried", () => {
    const f = zohoPurchaseFacts(detail({ reverseCharge: true, totalPaise: 1_000_00, taxTotalPaise: 180_00, taxes: [{ name: "IGST18", amountPaise: 180_00 }] }));
    expect(f).toMatchObject({ rcm: true, rcmTax: 180, igst: 0, cgst: 0, sgst: 0, tax: 0, total: 1000 });
  });

  it("TDS by section from Zoho's TDS name (professional fees → 194JB); amount in rupees", () => {
    const f = zohoPurchaseFacts(detail({ tdsPaise: 100_00, raw: { tds_tax_name: "Professional Fees [10%] - 194 J" } }));
    expect(f).toMatchObject({ tdsAmount: 100, tdsSection: "194JB" });
  });

  it("TDS without a readable section is a problem (never guessed)", () => {
    const f = zohoPurchaseFacts(detail({ tdsPaise: 100_00, raw: {} }));
    expect(f.tdsSection).toBeNull();
    expect(f.problems.join(" ")).toMatch(/TDS section/);
  });

  it("void and draft keep their status (the plan skips them)", () => {
    expect(zohoPurchaseFacts(detail({ status: "Void" })).status).toBe("void");
    expect(zohoPurchaseFacts(detail({ status: "draft" })).status).toBe("draft");
  });

  it("not INR, or an adjustment → a problem", () => {
    expect(zohoPurchaseFacts(detail({ currency: "USD" })).problems.join(" ")).toMatch(/USD/);
    expect(zohoPurchaseFacts(detail({ raw: { adjustment: 2.5 } })).problems.join(" ")).toMatch(/adjustment/i);
  });

  it("GST with no head in the taxes list: split by place of supply vs the GSTIN's state", () => {
    const same = zohoPurchaseFacts(detail({ taxes: [], raw: { source_of_supply: "DL", destination_of_supply: "DL" } }));
    expect(same).toMatchObject({ cgst: 90, sgst: 90, igst: 0 });
    const inter = zohoPurchaseFacts(detail({ taxes: [], raw: { source_of_supply: "MH", destination_of_supply: "DL" } }));
    expect(inter).toMatchObject({ igst: 180, cgst: 0, sgst: 0 });
  });

  it("an expense: its account is the one line; paid-through account kept", () => {
    const f = zohoPurchaseFacts(detail({
      kind: "expenses", id: "E1", number: "", status: "nonbillable", totalPaise: 590_00,
      raw: { paid_through_account_name: "HDFC 4523", reference_number: "" },
      lines: [{ accountId: "A9", accountName: "Office Rent", description: "", hsnOrSac: "", quantity: 1, amountPaise: 500_00, taxId: "", taxName: "", taxPercent: 18 }],
      taxes: [{ name: "IGST18", amountPaise: 90_00 }], taxTotalPaise: 90_00,
    }));
    expect(f).toMatchObject({ kind: "expenses", zohoId: "E1", number: "", taxable: 500, igst: 90, total: 590, paidThrough: "HDFC 4523" });
  });
});

describe("tdsSectionOf", () => {
  /* The app's own section codes (lib/accounting/tds-rates.ts): 194J split three ways (R-2338),
     rent 194-I(a)/(b) is the app's one "194I" (194IA is a different section — property purchase). */
  it.each([
    ["194J", "194J"], ["Section 194C", "194C"], ["194 J - Professional", "194JB"], ["Professional Fees [10%] - 194J", "194JB"],
    ["Technical Services - 194J", "194JA"], ["194J(a)", "194JA"], ["194J(b)", "194JB"], ["Royalty 194J", "194JR"],
    ["Rent - 194-I(b)", "194I"], ["Rent on plant - 194-I(a)", "194I"], ["194I", "194I"],
    ["194Q", "194Q"], ["Commission 194H", "194H"], ["", null], ["10%", null],
  ])("%s → %s", (input, out) => expect(tdsSectionOf(input)).toBe(out));
});

describe("TDS section — read from the section TEXT, never an id", () => {
  it("a numeric id in tds_section (with 19x digits inside) is not a section", () => {
    const f = zohoPurchaseFacts(detail({ tdsPaise: 100_00, raw: { tds_section: "460000000194123", tds_tax_name: "Contractor - 194C" } }));
    expect(f.tdsSection).toBe("194C");
    const g = zohoPurchaseFacts(detail({ tdsPaise: 100_00, raw: { tds_section: "460000000194123" } }));
    expect(g.tdsSection).toBeNull();
  });
});

describe("zohoVendorPaymentFacts", () => {
  it("amount, bills it pays, the unapplied rest and the paid-through account — in rupees", () => {
    const f = zohoVendorPaymentFacts({
      kind: "vendorpayments", id: "P1", number: "7", date: "2025-06-01", status: "", contactId: "V1", contactName: "Mehta Cloud",
      totalPaise: 1_500_00, balancePaise: 320_00, currency: "INR",
      raw: { paid_through_account_name: "HDFC 4523", payment_mode: "Bank Transfer", reference_number: "UTR1",
        bills: [{ bill_id: "B1", bill_number: "VB-1", amount_applied: 1180 }] },
      lines: [], taxes: [], taxTotalPaise: 0, tdsPaise: 0, gstNo: "", gstTreatment: "", placeOfSupply: "", reverseCharge: false,
    });
    expect(f).toMatchObject({ kind: "vendorpayments", zohoId: "P1", number: "7", date: "2025-06-01", amount: 1500, unapplied: 320,
      paidThrough: "HDFC 4523", mode: "Bank Transfer", reference: "UTR1", applied: [{ billZohoId: "B1", billNumber: "VB-1", amount: 1180 }], problems: [] });
  });
});

describe("review fixes — rounding and RCM", () => {
  it("CGST 9.50 + SGST 9.50 = ₹19 (rounded once, not head by head)", () => {
    const f = zohoPurchaseFacts(detail({ taxes: [{ name: "CGST9", amountPaise: 9_50 }, { name: "SGST9", amountPaise: 9_50 }], taxTotalPaise: 19_00,
      totalPaise: 1_019_00 }));
    expect(f).toMatchObject({ tax: 19, cgst: 10, sgst: 9 });
  });
  it("RCM: the self-assessed GST from reverse_charge_tax_total when the vendor charged none", () => {
    const f = zohoPurchaseFacts(detail({ reverseCharge: true, totalPaise: 1_000_00, taxTotalPaise: 0, taxes: [], raw: { reverse_charge_tax_total: 180 } }));
    expect(f).toMatchObject({ rcm: true, rcmTax: 180, tax: 0, total: 1000 });
    expect(f.lines[0].tax).toBe(180);
  });
});
