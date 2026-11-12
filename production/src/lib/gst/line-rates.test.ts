/* R-2717 — GST rate per invoice line: the one slicing rule every report, the PDF and the
   credit-note preview use. Owner example: a Zoho invoice with a 0% line and an 18% line
   (INV/25-26/1248 kind) — ₹10,000 at 0% + ₹20,000 at 18%, GST ₹3,600, total ₹33,600. */
import { describe, expect, it } from "vitest";
import {
  docRates, invoiceNoteMixedRates, isMixedRate, lineOwnRate, lineRateShares, linesRateSlices, mixedRateNoteSplit,
  noteMixedSplitText, outputRateLabel, pdfTaxRows, rateLabel, rateSlices,
} from "./line-rates";

const mixedLines = [
  { name: "Domain (export, LUT)", qty: 1, rate: 10000, tax_rate: 0 },
  { name: "Workspace", qty: 2, rate: 10000, tax_rate: 18 },
];
const doc = { taxableValue: 30000, gst: 3600, taxRate: 18 };

describe("R-2717 rateSlices", () => {
  it("one rate = one slice with the document's own figures", () => {
    // Lines with no tax_rate (every invoice before R-2717): the document's rate, untouched —
    // even when its GST is not exactly rate × taxable (as filed).
    expect(linesRateSlices({ taxableValue: 30000, gst: 5401, taxRate: 18 }, [{ qty: 1, rate: 10000 }, { qty: 2, rate: 10000 }]))
      .toEqual([{ rate: 18, taxable: 30000, gst: 5401 }]);
    // No lines at all.
    expect(linesRateSlices({ taxableValue: 500, gst: 90, taxRate: 18 }, null)).toEqual([{ rate: 18, taxable: 500, gst: 90 }]);
    // Every line carries the SAME own rate → still one slice.
    expect(linesRateSlices({ taxableValue: 30000, gst: 5400, taxRate: 18 }, mixedLines.map((l) => ({ ...l, tax_rate: 18 }))))
      .toEqual([{ rate: 18, taxable: 30000, gst: 5400 }]);
  });

  it("0% + 18% lines: a slice per rate, lowest first, adding up to the invoice", () => {
    const s = linesRateSlices(doc, mixedLines);
    expect(s).toEqual([{ rate: 0, taxable: 10000, gst: 0 }, { rate: 18, taxable: 20000, gst: 3600 }]);
    expect(isMixedRate(s)).toBe(true);
    expect(rateLabel(s)).toBe("0% + 18%");
  });

  it("rounding gap on the highest rate — the 0% slice never carries GST", () => {
    // Zoho filed ₹3,601 (its own rounding). Kept as filed: the ₹1 sits on the 18% slice.
    const s = linesRateSlices({ ...doc, gst: 3601 }, mixedLines);
    expect(s).toEqual([{ rate: 0, taxable: 10000, gst: 0 }, { rate: 18, taxable: 20000, gst: 3601 }]);
    // Three rates: 5% + 18% computed, the gap on 18%.
    const three = rateSlices({ taxableValue: 3000, gst: 231, taxRate: 18 }, [
      { taxable: 1000, rate: 0 }, { taxable: 1000, rate: 5 }, { taxable: 1000, rate: 18 },
    ]);
    expect(three).toEqual([{ rate: 0, taxable: 1000, gst: 0 }, { rate: 5, taxable: 1000, gst: 50 }, { rate: 18, taxable: 1000, gst: 181 }]);
    expect(three.reduce((a, x) => a + x.gst, 0)).toBe(231);
  });

  it("a line with no rate of its own takes the document's rate", () => {
    const s = linesRateSlices(doc, [{ qty: 1, rate: 10000, tax_rate: 0 }, { qty: 2, rate: 10000 }]);
    expect(s).toEqual([{ rate: 0, taxable: 10000, gst: 0 }, { rate: 18, taxable: 20000, gst: 3600 }]);
  });

  it("adjustment / zero lines carry no share and no rate", () => {
    const lines = [...mixedLines, { name: "Adjustment", qty: 1, rate: -250, kind: "adjustment", tax_rate: 5 }, { name: "Free", qty: 1, rate: 0, tax_rate: 28 }];
    expect(lineRateShares(30000, lines)).toEqual([{ taxable: 10000, rate: 0 }, { taxable: 20000, rate: 18 }]);
    expect(linesRateSlices(doc, lines).map((x) => x.rate)).toEqual([0, 18]);
  });

  it("the invoice taxable (after a discount) is shared by line value, remainder on the last line", () => {
    // ₹30,000 of lines, taxable ₹27,001 after a discount.
    const shares = lineRateShares(27001, mixedLines);
    expect(shares).toEqual([{ taxable: 9000, rate: 0 }, { taxable: 18001, rate: 18 }]);
  });

  it("a credit note comes in negative — signed slices that add up", () => {
    const s = rateSlices({ taxableValue: -15000, gst: -1800, taxRate: 18 }, [{ taxable: -5000, rate: 0 }, { taxable: -10000, rate: 18 }]);
    expect(s).toEqual([{ rate: 0, taxable: -5000, gst: 0 }, { rate: 18, taxable: -10000, gst: -1800 }]);
  });

  it("lineOwnRate reads only a real, non-negative number", () => {
    expect(lineOwnRate({ tax_rate: 0 })).toBe(0);
    expect(lineOwnRate({ tax_rate: 18 })).toBe(18);
    expect(lineOwnRate({})).toBeNull();
    expect(lineOwnRate({ tax_rate: null })).toBeNull();
    expect(lineOwnRate({ tax_rate: -1 })).toBeNull();
    expect(lineOwnRate({ tax_rate: Number.NaN })).toBeNull();
    expect(lineOwnRate({ tax_rate: "18" as unknown as number })).toBeNull();
  });
});

describe("R-2717 noteSplit — a credit / debit note on a mixed-rate invoice", () => {
  it("splits in the invoice's own taxable : GST proportion (same as SQL issue_credit_note)", () => {
    // Half of ₹33,600.
    expect(mixedRateNoteSplit(16800, { taxableValue: 30000, taxAmount: 3600 })).toEqual({ taxable: 15000, tax: 1800 });
    // The whole invoice → its exact figures.
    expect(mixedRateNoteSplit(33600, { taxableValue: 30000, taxAmount: 3600 })).toEqual({ taxable: 30000, tax: 3600 });
    // Odd amount: taxable rounded once, tax is the rest — the two always add up to the note.
    const odd = mixedRateNoteSplit(1001, { taxableValue: 30000, taxAmount: 3600 });
    expect(odd).toEqual({ taxable: 894, tax: 107 });
  });
  it("is null when the invoice figures give no proportion", () => {
    expect(mixedRateNoteSplit(100, { taxableValue: null, taxAmount: 0 })).toBeNull();
    expect(mixedRateNoteSplit(100, { taxableValue: 0, taxAmount: 0 })).toBeNull();
  });
});

describe("R-2717 invoiceNoteMixedRates — the same 'different rates?' test as SQL invoice_note_gst_split", () => {
  const inv = (tax_rate: number | null, line_items: unknown) => ({ taxable_value: 30000, tax_amount: 3600, tax_rate, line_items });
  it("0% + 18% lines → mixed, with the invoice's figures", () => {
    expect(invoiceNoteMixedRates(inv(null, mixedLines))).toEqual({ taxableValue: 30000, taxAmount: 3600, rates: [0, 18] });
  });
  it("[0% line, line with no rate] on an 18% invoice is two rates (SQL test M)", () => {
    expect(invoiceNoteMixedRates(inv(18, [{ qty: 1, rate: 10000, tax_rate: 0 }, { qty: 2, rate: 10000 }]))?.rates).toEqual([0, 18]);
  });
  it("one rate → null: no line rates, all the same rate, or only adjustment / ₹0 lines differ (SQL tests C0, N)", () => {
    expect(invoiceNoteMixedRates(inv(18, [{ qty: 1, rate: 10000 }, { qty: 2, rate: 10000 }]))).toBeNull();
    expect(invoiceNoteMixedRates(inv(null, [
      { qty: 1, rate: 10000, tax_rate: 18 }, { qty: 2, rate: 10000, tax_rate: 18 },
      { qty: 1, rate: -250, kind: "adjustment", tax_rate: 5 }, { qty: 1, rate: 0, tax_rate: 0 },
    ]))).toBeNull();
    expect(invoiceNoteMixedRates(inv(18, null))).toBeNull();
    expect(invoiceNoteMixedRates(inv(18, "junk"))).toBeNull();
  });
  it("the dialog text names the rates and the split", () => {
    expect(noteMixedSplitText({ rates: [0, 18], interState: true, taxable: "₹15,000", tax: "₹1,800" }))
      .toBe("This invoice has lines at different GST rates (0% + 18%). The note is split like the invoice: taxable ₹15,000 + IGST ₹1,800.");
  });
});

describe("R-2717 outputRateLabel / docRates — the GST output table's Tax cell", () => {
  it("one rate → the words it always showed", () => {
    expect(outputRateLabel({ isExport: false, gst: 180, interState: true, taxRate: 18 })).toBe("IGST 18%");
    expect(outputRateLabel({ isExport: false, gst: 180, interState: false, taxRate: 18 })).toBe("CGST 9% + SGST 9%");
    expect(outputRateLabel({ isExport: true, gst: 0, interState: false, taxRate: 0 })).toBe("Export · LUT (0%)");
    expect(outputRateLabel({ isExport: true, gst: 180, interState: false, taxRate: 18 })).toBe("Export · IGST 18%");
  });
  it("several rates → every rate named", () => {
    expect(outputRateLabel({ isExport: false, gst: 3600, interState: true, taxRate: 18, rates: [0, 18] })).toBe("IGST 0% + 18%");
    expect(outputRateLabel({ isExport: false, gst: 3600, interState: false, taxRate: 18, rates: [0, 18] })).toBe("CGST + SGST 0% + 18%");
    expect(outputRateLabel({ isExport: true, gst: 3600, interState: false, taxRate: 18, rates: [0, 18] })).toBe("Export · IGST 0% + 18%");
  });
  it("docRates: the highest rate + the list for a mixed document; its own rate otherwise", () => {
    expect(docRates({ taxableValue: 30000, gst: 3600, taxRate: 12 }, [{ taxable: 10000, rate: 0 }, { taxable: 20000, rate: 18 }])).toEqual({ taxRate: 18, rates: [0, 18] });
    expect(docRates({ taxableValue: 30000, gst: 5400, taxRate: 18 }, [{ taxable: 30000 }])).toEqual({ taxRate: 18 });
  });
});

describe("R-2717 pdfTaxRows — tax summary per rate on the invoice PDF", () => {
  const money = (n: number) => `Rs ${n}`;
  it("single rate → null (the PDF keeps its one row)", () => {
    expect(pdfTaxRows([{ rate: 18, taxable: 30000, gst: 5400 }], true, money)).toBeNull();
  });
  it("inter-state: one IGST row per rate, each naming its taxable value", () => {
    expect(pdfTaxRows(linesRateSlices(doc, mixedLines), true, money)).toEqual([
      { label: "IGST @ 0% on Rs 10000", amount: 0 },
      { label: "IGST @ 18% on Rs 20000", amount: 3600 },
    ]);
  });
  it("intra-state: CGST + SGST halves per rate, the odd rupee by the shared split", () => {
    const rows = pdfTaxRows(linesRateSlices({ ...doc, gst: 3601 }, mixedLines), false, money);
    expect(rows).toEqual([
      { label: "CGST @ 0% on Rs 10000", amount: 0 },
      { label: "SGST @ 0% on Rs 10000", amount: 0 },
      { label: "CGST @ 9% on Rs 20000", amount: 1801 },
      { label: "SGST @ 9% on Rs 20000", amount: 1800 },
    ]);
  });
});
