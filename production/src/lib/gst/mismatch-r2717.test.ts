/* R-2717 — the GST mismatch check on an invoice whose lines carry different GST rates.
   Before: gst-health read `inv.tax_rate ?? 0`, so a correct 0% + 18% invoice (tax_rate NULL)
   came back with a CRITICAL "the tax on this invoice is not 0% of the taxable value". */
import { describe, expect, it } from "vitest";
import { auditInvoiceGst, invoiceGstFacts, type InvoiceGstFacts } from "./mismatch";

const SELLER = { stateCode: "07", gstin: "07ABDCA0000A1Z5", country: "India" };
const BUYER = { stateCode: "29", gstin: null, country: "India" };
const lines = [{ qty: 1, rate: 10000, tax_rate: 0 }, { qty: 2, rate: 10000, tax_rate: 18 }];

/** The facts as gst-health builds them for a mixed invoice: tax_rate NULL → 0, rates from the lines. */
function facts(taxAmount: number): InvoiceGstFacts {
  return invoiceGstFacts({ taxable_value: 30000, tax_amount: taxAmount, tax_rate: null, inter_state: true, gst_treatment: null, line_items: lines });
}
const codes = (f: InvoiceGstFacts) => auditInvoiceGst(f, BUYER, SELLER).map((i) => i.code);

describe("R-2717 GST mismatch check by line rate", () => {
  it("a correct 0% + 18% invoice has no arithmetic finding", () => {
    expect(codes(facts(3600))).not.toContain("tax_arithmetic");
    // ₹1 of Zoho rounding is inside the tolerance.
    expect(codes(facts(3601))).not.toContain("tax_arithmetic");
  });

  it("without the line rates the same invoice is a false critical (what the check did before)", () => {
    const { rates: _r, ...old } = facts(3600);
    expect(codes(old)).toContain("tax_arithmetic");
  });

  it("GST ₹500 off its lines → tax_arithmetic, naming each rate's share; risk = the difference", () => {
    const issue = auditInvoiceGst(facts(4100), BUYER, SELLER).find((i) => i.code === "tax_arithmetic");
    expect(issue?.severity).toBe("critical");
    expect(issue?.headline).toBe("The tax on this invoice is not its lines' GST rates (0% + 18%) applied to their taxable values.");
    expect(issue?.detail).toContain("Taxable 10000 at 0% + 20000 at 18% is 3600, but the invoice charges 4100.");
    expect(issue?.amountAtRisk).toBe(500);
  });

  it("the 18% lines are not questioned; the 0% line gets the same 'worth a look' warning a 0% invoice gets", () => {
    const warn = auditInvoiceGst(facts(3600), BUYER, SELLER).filter((i) => i.code === "unexpected_rate");
    expect(warn).toHaveLength(1);
    expect(warn[0].severity).toBe("warning");
    expect(warn[0].headline).toBe("Some lines are charged at 0% where this business's services attract 18%.");
  });

  it("invoiceGstFacts: rates only for a mixed invoice; lines with no rate / no lines leave the row as it was", () => {
    expect(facts(3600).rates).toEqual([{ rate: 0, taxable: 10000 }, { rate: 18, taxable: 20000 }]);
    const plain = invoiceGstFacts({ taxable_value: 30000, tax_amount: 5400, tax_rate: 18, inter_state: false, line_items: [{ qty: 3, rate: 10000 }] });
    expect(plain).toEqual({ taxableValue: 30000, taxAmount: 5400, taxRate: 18, interState: false, gstTreatment: undefined });
    expect(invoiceGstFacts({ taxable_value: null, tax_amount: null, tax_rate: null, inter_state: null, line_items: "junk" }).rates).toBeUndefined();
  });

  it("tax_rate NULL but every line at ONE rate → checked at that rate (not at 0%)", () => {
    const five = invoiceGstFacts({ taxable_value: 30000, tax_amount: 1500, tax_rate: null, inter_state: true, line_items: lines.map((l) => ({ ...l, tax_rate: 5 })) });
    expect(five.taxRate).toBe(5);
    expect(five.rates).toBeUndefined();
    expect(codes(five)).not.toContain("tax_arithmetic");
    // One valued line without a rate → the row's own rate (all or nothing).
    expect(invoiceGstFacts({ taxable_value: 30000, tax_amount: 5400, tax_rate: 18, inter_state: true, line_items: [lines[0], { qty: 2, rate: 10000 }] }).taxRate).toBe(18);
  });

  it("a single-rate invoice is checked exactly as before (one slice = no `rates` effect)", () => {
    const one: InvoiceGstFacts = { taxableValue: 30000, taxAmount: 5400, taxRate: 18, interState: true, rates: [{ rate: 18, taxable: 30000 }] };
    expect(auditInvoiceGst(one, BUYER, SELLER)).toEqual([]);
    expect(codes({ ...one, taxAmount: 5000 })).toEqual(["tax_arithmetic"]);
  });
});
