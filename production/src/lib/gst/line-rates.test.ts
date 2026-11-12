/* R-2717 — GST rate per invoice line: the one slicing rule every report, the PDF and the
   credit-note preview use. Owner example: a Zoho invoice with a 0% line and an 18% line
   (INV/25-26/1248 kind) — ₹10,000 at 0% + ₹20,000 at 18%, GST ₹3,600, total ₹33,600. */
import { describe, expect, it } from "vitest";
import {
  docRates, invoiceRateText, isMixedRate, lineOwnRate, lineRateSet, lineRateShares, linesRateSlices, lineWeight,
  noteMixedSplitText, noteRefusedText, noteSplit, noteSplitRule, outputRateLabel, pdfTaxRows, rateLabel, rateSlices,
  shareByWeight, sliceHeads,
} from "./line-rates";

const mixedLines = [
  { name: "Domain (export, LUT)", qty: 1, rate: 10000, amount: 10000, tax_rate: 0 },
  { name: "Workspace", qty: 2, rate: 10000, amount: 20000, tax_rate: 18 },
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
  });

  it("every line at the SAME own rate → one slice at THAT rate (the row's tax_rate may be NULL)", () => {
    // tax_rate NULL on the row arrives here as a fallback (18 on the PDF, 0 in the audit) — the lines win.
    expect(linesRateSlices({ taxableValue: 30000, gst: 1500, taxRate: 18 }, mixedLines.map((l) => ({ ...l, tax_rate: 5 }))))
      .toEqual([{ rate: 5, taxable: 30000, gst: 1500 }]);
    expect(linesRateSlices({ taxableValue: 30000, gst: 0, taxRate: 18 }, mixedLines.map((l) => ({ ...l, tax_rate: 0 }))))
      .toEqual([{ rate: 0, taxable: 30000, gst: 0 }]);
  });

  it("0% + 18% lines: a slice per rate, lowest first, adding up to the invoice", () => {
    const s = linesRateSlices(doc, mixedLines);
    expect(s).toEqual([{ rate: 0, taxable: 10000, gst: 0 }, { rate: 18, taxable: 20000, gst: 3600 }]);
    expect(isMixedRate(s)).toBe(true);
    expect(rateLabel(s.map((x) => x.rate))).toBe("0% + 18%");
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

  it("all or nothing: ONE valued line without a rate → an ordinary one-rate invoice, line rates ignored", () => {
    // No "this line takes the invoice's rate" guess — PDF, audit, GSTR-1 and SQL all read it as one rate.
    const lines = [{ qty: 1, rate: 10000, tax_rate: 0 }, { qty: 2, rate: 10000 }];
    expect(linesRateSlices({ taxableValue: 30000, gst: 5400, taxRate: 18 }, lines)).toEqual([{ rate: 18, taxable: 30000, gst: 5400 }]);
    expect(lineRateSet(lines)).toBeNull();
  });

  it("adjustment / zero lines carry no share and no rate", () => {
    const lines = [...mixedLines, { name: "Adjustment", qty: 1, rate: -250, kind: "adjustment", tax_rate: 5 }, { name: "Free", qty: 1, rate: 0, amount: 0, tax_rate: 28 }];
    expect(lineRateShares(30000, lines)).toEqual([{ taxable: 10000, rate: 0 }, { taxable: 20000, rate: 18 }]);
    expect(linesRateSlices(doc, lines).map((x) => x.rate)).toEqual([0, 18]);
    expect(lineRateSet(lines)).toEqual([0, 18]);
    // A positive adjustment line never counts either.
    expect(lineWeight({ qty: 1, rate: 500, kind: "adjustment" })).toBe(0);
  });

  it("a rated line is weighed by its own `amount` (Zoho's line value after a line discount), not qty × rate", () => {
    // Line A: 0%, 1 × ₹10,000 with a 50% line discount → amount 5,000. Line B: 18%, ₹20,000. GST 3,600.
    const lines = [{ qty: 1, rate: 10000, amount: 5000, tax_rate: 0 }, { qty: 1, rate: 20000, amount: 20000, tax_rate: 18 }];
    expect(linesRateSlices({ taxableValue: 25000, gst: 3600, taxRate: 0 }, lines))
      .toEqual([{ rate: 0, taxable: 5000, gst: 0 }, { rate: 18, taxable: 20000, gst: 3600 }]);
    // A line with no rate of its own keeps qty × rate (as the HSN table always weighed it), whatever `amount` says.
    expect(lineWeight({ qty: 2, rate: 100, amount: 999 })).toBe(200);
    expect(lineWeight({ qty: 2, rate: 100, amount: 150, tax_rate: 18 })).toBe(150);
  });

  it("the invoice taxable (after a document discount) is shared by line value, remainder on the last line", () => {
    expect(lineRateShares(27001, mixedLines)).toEqual([{ taxable: 9000, rate: 0 }, { taxable: 18001, rate: 18 }]);
    expect(shareByWeight(100, [1, 1, 1])).toEqual([33, 33, 34]);
    expect(shareByWeight(-100, [1, 3])).toEqual([-25, -75]);
  });

  it("a credit note comes in negative — signed slices that add up, never −0", () => {
    const s = rateSlices({ taxableValue: -15000, gst: -1800, taxRate: 18 }, [{ taxable: -5000, rate: 0 }, { taxable: -10000, rate: 18 }]);
    expect(s).toEqual([{ rate: 0, taxable: -5000, gst: 0 }, { rate: 18, taxable: -10000, gst: -1800 }]);
    expect(Object.is(s[0].gst, -0)).toBe(false);
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

describe("R-2717 sliceHeads — one head split for the PDF and GSTR-1", () => {
  it("per-rate CGST / SGST add up to the document's own heads (the highest rate takes the rest)", () => {
    // 5% slice GST 251 + 18% slice GST 1,801 = 2,052 → the document is CGST 1,026 + SGST 1,026.
    const slices = [{ rate: 5, taxable: 5020, gst: 251 }, { rate: 18, taxable: 10006, gst: 1801 }];
    const heads = sliceHeads(slices, false);
    expect(heads).toEqual([{ igst: 0, cgst: 126, sgst: 125 }, { igst: 0, cgst: 900, sgst: 901 }]);
    expect(heads.reduce((a, h) => a + h.cgst, 0)).toBe(1026);
    expect(heads.reduce((a, h) => a + h.sgst, 0)).toBe(1026);
  });
  it("inter-state: all IGST", () => {
    expect(sliceHeads([{ rate: 0, taxable: 10000, gst: 0 }, { rate: 18, taxable: 20000, gst: 3600 }], true))
      .toEqual([{ igst: 0, cgst: 0, sgst: 0 }, { igst: 3600, cgst: 0, sgst: 0 }]);
  });
});

describe("R-2717 noteSplitRule / noteSplit — a credit / debit note (the same rule as SQL invoice_note_gst_split)", () => {
  const inv = (tax_rate: number | null, line_items: unknown, taxable_value: number | null = 30000, tax_amount: number | null = 3600) =>
    ({ taxable_value, tax_amount, tax_rate, line_items });

  it("0% + 18% lines → split in the invoice's own taxable : GST proportion (SQL C1, C2)", () => {
    const rule = noteSplitRule(inv(null, mixedLines));
    expect(rule).toEqual({ kind: "mixed", rates: [0, 18], taxableValue: 30000, taxAmount: 3600 });
    expect(noteSplit(16800, rule)).toEqual({ taxable: 15000, tax: 1800 });   // half of ₹33,600
    expect(noteSplit(33600, rule)).toEqual({ taxable: 30000, tax: 3600 });   // the whole invoice → its exact figures
    expect(noteSplit(1001, rule)).toEqual({ taxable: 894, tax: 107 });       // rounded once; the two add up to the note
    expect(noteSplit(3360, rule)).toEqual({ taxable: 3000, tax: 360 });      // SQL D1
  });

  it("no line rates → the invoice's rate, else 18, exactly as before (SQL C0)", () => {
    expect(noteSplitRule(inv(18, [{ qty: 1, rate: 10000 }, { qty: 2, rate: 10000 }]))).toEqual({ kind: "rate", rate: 18 });
    expect(noteSplitRule(inv(null, [{ qty: 1, rate: 1000 }]))).toEqual({ kind: "rate", rate: 18 });
    expect(noteSplitRule(inv(0, null))).toEqual({ kind: "rate", rate: 0 });
    expect(noteSplitRule(inv(18, "junk"))).toEqual({ kind: "rate", rate: 18 });
    expect(noteSplit(11800, { kind: "rate", rate: 18 })).toEqual({ taxable: 10000, tax: 1800 });
    expect(noteSplit(500, { kind: "rate", rate: 0 })).toEqual({ taxable: 500, tax: 0 });
  });

  it("all or nothing: [0% line, line with no rate] on an 18% invoice is the invoice's 18% (SQL M)", () => {
    expect(noteSplitRule(inv(18, [{ qty: 1, rate: 10000, tax_rate: 0 }, { qty: 2, rate: 10000 }]))).toEqual({ kind: "rate", rate: 18 });
  });

  it("every valued line at one rate → that rate, never the 18% default (SQL N, N2)", () => {
    expect(noteSplitRule(inv(null, [
      { qty: 1, rate: 10000, tax_rate: 18 }, { qty: 2, rate: 10000, tax_rate: 18 },
      { qty: 1, rate: -250, kind: "adjustment", tax_rate: 5 }, { qty: 1, rate: 0, amount: 0, tax_rate: 0 },
    ]))).toEqual({ kind: "rate", rate: 18 });
    const zero = noteSplitRule(inv(null, [{ qty: 1, rate: 10000, amount: 10000, tax_rate: 0 }, { qty: 1, rate: 0, amount: 0, tax_rate: 18 }], 10000, 0));
    expect(zero).toEqual({ kind: "rate", rate: 0 });
    expect(noteSplit(4000, zero)).toEqual({ taxable: 4000, tax: 0 });
  });

  it("different rates but no taxable / GST on the invoice → refused, with the reason (SQL R)", () => {
    const rule = noteSplitRule(inv(null, mixedLines, null, null));
    expect(rule).toEqual({ kind: "refused", rates: [0, 18] });
    expect(noteSplit(1000, rule)).toBeNull();
    expect(noteSplitRule(inv(null, mixedLines, 0, 0)).kind).toBe("refused");
    expect(noteRefusedText([0, 18])).toBe("This invoice has lines at different GST rates (0% + 18%) but no taxable value and GST on record, so a note cannot be split. Correct the invoice first.");
  });

  it("the dialog text names the rates and the split", () => {
    expect(noteMixedSplitText({ rates: [0, 18], interState: true, taxable: "₹15,000", tax: "₹1,800" }))
      .toBe("This invoice has lines at different GST rates (0% + 18%). The note is split like the invoice: taxable ₹15,000 + IGST ₹1,800.");
    expect(noteMixedSplitText({ rates: [0, 18], interState: false, taxable: "₹15,000", tax: "₹1,800" })).toContain("CGST + SGST ₹1,800");
  });
});

describe("R-2717 labels — GST output table, invoice screen", () => {
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
  it("docRates: the highest rate + the list for a mixed document; the lines' one rate; else its own rate", () => {
    expect(docRates({ taxableValue: 30000, gst: 3600, taxRate: 12 }, [{ taxable: 10000, rate: 0 }, { taxable: 20000, rate: 18 }])).toEqual({ taxRate: 18, rates: [0, 18] });
    expect(docRates({ taxableValue: 30000, gst: 1500, taxRate: 18 }, [{ taxable: 10000, rate: 5 }, { taxable: 20000, rate: 5 }])).toEqual({ taxRate: 5 });
    expect(docRates({ taxableValue: 30000, gst: 5400, taxRate: 18 }, [{ taxable: 30000 }])).toEqual({ taxRate: 18 });
    expect(docRates({ taxableValue: 30000, gst: 5400, taxRate: 18 }, [{ taxable: 10000, rate: 0 }, { taxable: 20000 }])).toEqual({ taxRate: 18 });
  });
  it("invoiceRateText: every line rate beside the tax total; the screen's own rate when the invoice carries none", () => {
    expect(invoiceRateText({ line_items: mixedLines }, 18)).toBe("0% + 18%");
    expect(invoiceRateText({ line_items: [{ qty: 1, rate: 100 }] }, 18)).toBe("18%");
    expect(invoiceRateText({ line_items: null }, 12)).toBe("12%");
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
  it("intra-state: CGST + SGST halves per rate — the same heads GSTR-1 files (sliceHeads)", () => {
    const rows = pdfTaxRows(linesRateSlices({ ...doc, gst: 3601 }, mixedLines), false, money);
    expect(rows).toEqual([
      { label: "CGST @ 0% on Rs 10000", amount: 0 },
      { label: "SGST @ 0% on Rs 10000", amount: 0 },
      { label: "CGST @ 9% on Rs 20000", amount: 1801 },
      { label: "SGST @ 9% on Rs 20000", amount: 1800 },
    ]);
    const two = pdfTaxRows([{ rate: 5, taxable: 5020, gst: 251 }, { rate: 18, taxable: 10006, gst: 1801 }], false, money)!;
    expect(two.filter((r) => r.label.startsWith("CGST")).reduce((a, r) => a + r.amount, 0)).toBe(1026);
    expect(two.filter((r) => r.label.startsWith("SGST")).reduce((a, r) => a + r.amount, 0)).toBe(1026);
  });
});
