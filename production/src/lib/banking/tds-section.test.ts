/**
 * R-2095 (30 Oct 2026, September reconcile): the reconcile drawer booked every TDS shortfall under
 * section 194J, whatever the rate — a 2% deduction by a company is 194C, 1% by an individual/HUF is
 * 194C, 10% is 194J. The section is now guessed from the rate (and the payer's PAN type from its
 * GSTIN), shown with the reason, and the user can change it.
 */
import { describe, it, expect } from "vitest";
import { tdsSectionGuess, TDS_SECTION_CHOICES, payerPanType } from "./tds-section";
import { payItemArgs, newSaleArgs } from "@/lib/queries/bank-credit-pay-for";

describe("R-2095 TDS section from the rate and the payer", () => {
  it("10% → 194J (professional / technical fees)", () => {
    expect(tdsSectionGuess(10, null)).toEqual({ section: "194J", reason: expect.stringMatching(/10%/) });
  });
  it("2% from a company → 194C, says company", () => {
    const g = tdsSectionGuess(2, "07AABCS1234F1Z5");
    expect(g.section).toBe("194C");
    expect(g.reason).toMatch(/company/i);
  });
  it("1% → 194C (individual / HUF payer)", () => {
    const g = tdsSectionGuess(1, "07ABCPK1234F1Z5");
    expect(g.section).toBe("194C");
    expect(g.reason).toMatch(/individual|HUF/i);
  });
  it("unknown rate → 194J with a 'check Form 16A' reason", () => {
    const g = tdsSectionGuess(null, null);
    expect(g.section).toBe("194J");
    expect(g.reason).toMatch(/Form 16A/);
  });
  it("PAN type from the GSTIN (4th PAN letter)", () => {
    expect(payerPanType("07AABCS1234F1Z5")).toBe("company");
    expect(payerPanType("07ABCPK1234F1Z5")).toBe("individual");
    expect(payerPanType("07ABCHK1234F1Z5")).toBe("huf");
    expect(payerPanType("07ABCFK1234F1Z5")).toBe("firm");
    expect(payerPanType(null)).toBeNull();
  });
  it("the choices offered include 194C and 194J", () => {
    expect(TDS_SECTION_CHOICES.map((c) => c.value)).toEqual(expect.arrayContaining(["194C", "194J"]));
  });
});

describe("R-2095 the chosen section reaches the server", () => {
  const base = { transactionId: "t", quoteId: "Q-1", invoiceId: null, tdsAmount: 1575, tdsRatePct: 2, createSubscription: null, subStart: null, subRenewal: null };
  it("payItemArgs / newSaleArgs send the picked section; 194J only when none is given", () => {
    expect(payItemArgs({ ...base, tdsSection: "194C" }).p_tds_section).toBe("194C");
    expect(payItemArgs(base).p_tds_section).toBe("194J");
    expect(newSaleArgs({ transactionId: "t", customerId: "c", lines: [], createSubscription: false, subStart: null, subRenewal: null, tdsAmount: 10, tdsRatePct: 1, tdsSection: "194C" }).p_tds_section).toBe("194C");
    expect(payItemArgs({ ...base, tdsAmount: 0, tdsSection: "194C" }).p_tds_section).toBeNull();
  });
});
