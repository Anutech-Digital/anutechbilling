/**
 * R-2425 — foreign inward remittances on a bank line. The five narrations are real HDFC 4523
 * lines (staging, 3 Nov 2026) that Reconcile from Zoho could not book.
 */
import { describe, expect, it } from "vitest";
import {
  exportLutProblem, formatRemittance, parseInwardRemittance, remittanceFitsCredit, remittanceInr,
} from "./inward-remittance";

describe("parseInwardRemittance — real HDFC narrations", () => {
  const cases: Array<[string, string, number, number, number]> = [
    ["INW 070826I049902623 USD1024.0@93.6", "USD", 1024, 93.6, 95846.4],
    ["INW 050826I049902522 USD1600.0@93.55", "USD", 1600, 93.55, 149680],
    ["INW 050826I049902875 USD759.0@93.55", "USD", 759, 93.55, 71004.45],
    ["INW 270726I049904499 USD1000.0@94.46", "USD", 1000, 94.46, 94460],
    ["INW 110926I049908171 USD56.0@93.99", "USD", 56, 93.99, 5263.44],
  ];
  for (const [narr, cur, amt, rate, inr] of cases) {
    it(narr, () => {
      const r = parseInwardRemittance(narr);
      expect(r).toEqual({ currency: cur, amount: amt, rate });
      expect(remittanceInr(r!)).toBe(inr);
      expect(remittanceFitsCredit(r!, inr)).toBe(true);
    });
  }

  it("reads EUR / GBP / AED, spaces and thousands separators", () => {
    expect(parseInwardRemittance("INW 0101 EUR 2,500.50 @ 101.2")).toEqual({ currency: "EUR", amount: 2500.5, rate: 101.2 });
    expect(parseInwardRemittance("inw 0101 gbp120@118.7")).toEqual({ currency: "GBP", amount: 120, rate: 118.7 });
    expect(parseInwardRemittance("INW X AED3672.5@25.48")).toEqual({ currency: "AED", amount: 3672.5, rate: 25.48 });
  });

  it("is null for ordinary INR lines and nonsense", () => {
    expect(parseInwardRemittance("NEFT CR-IDFB0080202-ACME PVT LTD-IDFB6202M2890149")).toBeNull();
    expect(parseInwardRemittance("UPI/123456789012/ACME@okhdfc")).toBeNull();
    expect(parseInwardRemittance(null)).toBeNull();
    expect(parseInwardRemittance("INW USD0@93.6")).toBeNull();
    expect(parseInwardRemittance("INW USD100@0")).toBeNull();
    expect(parseInwardRemittance("INW INR100@1")).toBeNull();
  });

  it("does not fit a credit that is not amount × rate (±₹1)", () => {
    const r = parseInwardRemittance("INW 070826I049902623 USD1024.0@93.6")!;
    expect(remittanceFitsCredit(r, 95847)).toBe(true);
    expect(remittanceFitsCredit(r, 95000)).toBe(false);
  });
});

describe("formatRemittance", () => {
  it("shows the foreign amount and the bank rate", () => {
    expect(formatRemittance({ currency: "USD", amount: 1024, rate: 93.6 })).toBe("$1,024 @ ₹93.60");
    expect(formatRemittance({ currency: "USD", amount: 759.5, rate: 93.55 })).toBe("$759.50 @ ₹93.55");
    expect(formatRemittance({ currency: "EUR", amount: 2500, rate: 101.2345 })).toBe("€2,500 @ ₹101.2345");
    expect(formatRemittance({ currency: "AED", amount: 10, rate: 25.48 })).toBe("AED 10 @ ₹25.48");
  });
});

/* R-2440 (independent review 2 of R-2425; tax memo 3 Nov §1): 0% export only under an LUT for the
   bank line's financial year — the same rule reconcile_bank_credit_new_sale_fx refuses on. */
describe("exportLutProblem — LUT for the receipt's financial year", () => {
  it("an LUT valid up to 31 Mar 2027 covers an August 2026 receipt", () => {
    expect(exportLutProblem({ number: "AD070426000123X", validUpto: "2027-03-31" }, "2026-08-07")).toBeNull();
  });
  it("no LUT number → refused, with the FY and the Settings step", () => {
    const p = exportLutProblem({ number: null, validUpto: null }, "2026-08-07");
    expect(p).toContain("No LUT for FY 2026-27 on file");
    expect(p).toContain("Settings");
  });
  it("a number without 'Valid up to' → refused (the FY cannot be told)", () => {
    expect(exportLutProblem({ number: "AD070426000123X", validUpto: null }, "2026-08-07")).toContain("No LUT for FY 2026-27");
  });
  it("last year's LUT (valid up to 31 Mar 2026) → refused for an FY 2026-27 receipt", () => {
    expect(exportLutProblem({ number: "AD070425000999X", validUpto: "2026-03-31" }, "2026-08-07")).toContain("No LUT for FY 2026-27");
  });
  it("next year's LUT does not cover a March 2026 receipt (FY 2025-26)", () => {
    expect(exportLutProblem({ number: "AD070426000123X", validUpto: "2027-03-31" }, "2026-03-20")).toContain("No LUT for FY 2025-26");
  });
  it("blank spaces are no LUT number", () => {
    expect(exportLutProblem({ number: "   ", validUpto: "2027-03-31" }, "2026-08-07")).not.toBeNull();
  });
});
