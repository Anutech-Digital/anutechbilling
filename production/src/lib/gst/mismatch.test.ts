import { describe, it, expect } from "vitest";
import { auditInvoiceGst, summariseGstIssues, type InvoiceGstFacts } from "./mismatch";

/* ANUTECH's own GSTIN, from CLAUDE.md §1 — a real, checksum-valid Delhi (07) number. Using
   the live one matters: a made-up GSTIN fails the checksum, so a test built on one would
   pass for the wrong reason and never exercise the valid-GSTIN paths at all. */
const SELLER = { stateCode: "07", gstin: "07ABDCA0298H1ZP", country: "India" };

const invoice = (over: Partial<InvoiceGstFacts> = {}): InvoiceGstFacts => ({
  taxableValue: 100000,
  taxAmount: 18000,
  taxRate: 18,
  interState: false,
  ...over,
});

const codes = (issues: ReturnType<typeof auditInvoiceGst>) => issues.map((i) => i.code);

describe("the finding this was built for: a head chosen by default", () => {
  it("flags an invoice whose customer has no state and no GSTIN", () => {
    /* Nine real customers are in exactly this state, Rs 10,87,908 of taxable value between
       them. isInterStateSupply returns false for an unknown buyer, and false means
       CGST + SGST — so "we do not know" and "same state as us" produce an identical,
       confident invoice. */
    const issues = auditInvoiceGst(invoice(), { stateCode: null, gstin: null, country: "India" }, SELLER);
    expect(codes(issues)).toContain("place_of_supply_unknown");
  });

  it("calls it CRITICAL, not a missing field", () => {
    /* Severity is the whole point. As a warning it sits in a list of tidy-ups; it is
       actually an unbacked tax decision on money already invoiced. */
    const [first] = auditInvoiceGst(invoice(), { stateCode: null, gstin: null }, SELLER);
    expect(first.code).toBe("place_of_supply_unknown");
    expect(first.severity).toBe("critical");
    expect(first.amountAtRisk).toBe(18000);
  });

  it("says which head was assumed, because the fix differs", () => {
    const intra = auditInvoiceGst(invoice({ interState: false }), { stateCode: null }, SELLER);
    const inter = auditInvoiceGst(invoice({ interState: true }), { stateCode: null }, SELLER);
    expect(intra[0].detail).toMatch(/intra-state \(CGST \+ SGST\)/);
    expect(inter[0].detail).toMatch(/inter-state \(IGST\)/);
  });

  it("stays quiet once the state is known and the head agrees", () => {
    /* The other half of the assertion. A checker that fires on healthy invoices is one
       nobody reads by the second week. */
    expect(auditInvoiceGst(invoice({ interState: false }), { stateCode: "07", country: "India" }, SELLER)).toEqual([]);
    expect(auditInvoiceGst(invoice({ interState: true }), { stateCode: "27", country: "India" }, SELLER)).toEqual([]);
  });
});

describe("the tax head, when both states ARE known", () => {
  it("catches CGST+SGST charged to another state", () => {
    const issues = auditInvoiceGst(invoice({ interState: false }), { stateCode: "27" }, SELLER);
    expect(codes(issues)).toContain("wrong_head");
    expect(issues[0].headline).toMatch(/another state/);
  });

  it("catches IGST charged inside your own state", () => {
    const issues = auditInvoiceGst(invoice({ interState: true }), { stateCode: "07" }, SELLER);
    expect(codes(issues)).toContain("wrong_head");
    expect(issues[0].headline).toMatch(/same state/);
  });

  it("treats '7' and '07' as one state", () => {
    /* A hand-typed code is often unpadded while a GSTIN-derived one always is. Reading
       those as two states would report a wrong head on a correct invoice — a false alarm
       on a tax screen, which is worse than silence. */
    expect(auditInvoiceGst(invoice({ interState: false }), { stateCode: "7" }, SELLER)).toEqual([]);
  });
});

describe("the GSTIN on file", () => {
  it("rejects the real broken one in the books", () => {
    /* AB corprotion carries "8947HIJR894FJ" — 13 characters, and 89 is not a state code.
       Five invoices, Rs 6,35,460 taxable. */
    const issues = auditInvoiceGst(invoice(), { stateCode: "32", gstin: "8947HIJR894FJ" }, SELLER);
    expect(codes(issues)).toContain("gstin_invalid");
  });

  it("rejects the other real broken one", () => {
    /* Jijo corprotion carries "T67TRY54UTRH5Y" — starts with letters where the state code
       goes. */
    expect(codes(auditInvoiceGst(invoice(), { gstin: "T67TRY54UTRH5Y" }, SELLER))).toContain("gstin_invalid");
  });

  it("catches a VALID GSTIN that disagrees with the recorded state", () => {
    /* Both look plausible on screen; one of them has been choosing the tax head. */
    const issues = auditInvoiceGst(
      invoice({ interState: true }),
      { stateCode: "27", gstin: "07ABDCA0298H1ZP" },
      SELLER,
    );
    expect(codes(issues)).toContain("gstin_contradicts_state");
  });

  it("does not complain when there is no GSTIN at all", () => {
    /* Unregistered customers are ordinary and legal. Nagging about them trains the reader
       to skim, and then the real findings go with it. */
    expect(codes(auditInvoiceGst(invoice(), { stateCode: "07" }, SELLER))).not.toContain("gstin_invalid");
  });
});

describe("arithmetic and rate", () => {
  it("catches tax that is not the rate applied", () => {
    const issues = auditInvoiceGst(invoice({ taxAmount: 12000 }), { stateCode: "07" }, SELLER);
    expect(codes(issues)).toContain("tax_arithmetic");
    /* The risk here is the DIFFERENCE, not the whole tax — the head is fine, the sum is
       not. Reporting the full amount would overstate it beside a wrong-head finding. */
    expect(issues[0].amountAtRisk).toBe(6000);
  });

  it("tolerates a rupee of rounding", () => {
    expect(codes(auditInvoiceGst(invoice({ taxAmount: 18001 }), { stateCode: "07" }, SELLER)))
      .not.toContain("tax_arithmetic");
  });

  it("treats an unusual rate as a warning, not an error", () => {
    /* A tenant may legitimately sell something on another rate. Calling every such line an
       error is how a checker gets switched off. */
    const issues = auditInvoiceGst(invoice({ taxRate: 5, taxAmount: 5000 }), { stateCode: "07" }, SELLER);
    const rate = issues.find((i) => i.code === "unexpected_rate");
    expect(rate?.severity).toBe("warning");
  });
});

describe("exports", () => {
  it("catches domestic GST charged to an overseas customer", () => {
    const issues = auditInvoiceGst(invoice(), { stateCode: null, country: "United States" }, SELLER);
    expect(codes(issues)).toContain("export_taxed_as_domestic");
    /* And it must NOT also complain about the place of supply — an export has no Indian
       place of supply to establish, so that finding would be noise on top of the real one. */
    expect(codes(issues)).not.toContain("place_of_supply_unknown");
  });

  it("is quiet on a zero-rated export", () => {
    expect(auditInvoiceGst(
      invoice({ taxAmount: 0, taxRate: 18 }),
      { country: "Singapore" },
      SELLER,
    )).toEqual([]);
  });
});

describe("worst first", () => {
  it("puts critical findings above warnings, and bigger money above smaller", () => {
    /* A list ordered by discovery makes the reader hunt. */
    const issues = auditInvoiceGst(
      invoice({ taxRate: 5, taxAmount: 3000, taxableValue: 100000 }),
      { stateCode: null, gstin: "T67TRY54UTRH5Y" },
      SELLER,
    );
    expect(issues[0].severity).toBe("critical");
    expect(issues[issues.length - 1].code).toBe("unexpected_rate");
  });
});

describe("the summary an owner actually reads", () => {
  it("counts each invoice's exposure once, not once per finding", () => {
    /* An invoice with a bad GSTIN AND an unknown place of supply does not put its tax at
       risk twice. A total that double-counts is one nobody trusts the second time. */
    const one = auditInvoiceGst(invoice(), { stateCode: null, gstin: "T67TRY54UTRH5Y" }, SELLER);
    expect(one.length).toBeGreaterThan(1);
    const s = summariseGstIssues([one]);
    expect(s.totalAtRisk).toBe(18000);
    expect(s.invoicesWithIssues).toBe(1);
  });

  it("adds up across invoices and keeps a per-code tally", () => {
    const a = auditInvoiceGst(invoice({ taxAmount: 18000 }), { stateCode: null }, SELLER);
    const b = auditInvoiceGst(invoice({ taxAmount: 9000, taxableValue: 50000 }), { stateCode: null }, SELLER);
    const clean = auditInvoiceGst(invoice(), { stateCode: "07" }, SELLER);
    const s = summariseGstIssues([a, b, clean]);
    expect(s.invoicesWithIssues).toBe(2);
    expect(s.totalAtRisk).toBe(27000);
    expect(s.byCode.place_of_supply_unknown).toBe(2);
  });
});

describe("R-1736: an SEZ customer is IGST in any state", () => {
  it("flags CGST + SGST on a Delhi SEZ invoice of a Delhi seller, and says why", () => {
    const issues = auditInvoiceGst(invoice({ interState: false, gstTreatment: "sez_with_payment" }), { stateCode: "07" }, SELLER);
    expect(codes(issues)).toContain("wrong_head");
    expect(issues[0].headline).toMatch(/SEZ/);
  });
  it("stays quiet on IGST for a Delhi SEZ (not 'IGST inside your own state')", () => {
    expect(auditInvoiceGst(invoice({ interState: true }), { stateCode: "07", gstTreatment: "sez_without_payment" }, SELLER)).toEqual([]);
  });
  it("the frozen invoice treatment wins over today's customer treatment", () => {
    expect(auditInvoiceGst(invoice({ interState: false, gstTreatment: "registered_regular" }), { stateCode: "07", gstTreatment: "sez_with_payment" }, SELLER)).toEqual([]);
  });
});
