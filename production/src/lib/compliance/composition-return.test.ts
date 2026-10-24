import { describe, expect, it } from "vitest";

import {
  billOfSupplyValue, cmp08Quarter, compositionCsv, compositionQuarters, gstr4DueDate, gstr4Year,
  isCompositionBill, COMPOSITION_CSV_HEADERS, type CompositionDoc, type CompositionNote,
} from "./composition-return";

/** R-1530 — CMP-08 (quarterly) and GSTR-4 (annual) maths for a composition business. */

const bos = (id: string, date: string, value: number, over: Partial<CompositionDoc> = {}): CompositionDoc => ({
  id, invoice_date: date, amount: value, taxable_value: value, status: "paid",
  document_kind: "bill_of_supply", supplier_gst_status: "composition", ...over,
});

describe("compositionQuarters", () => {
  it("splits the Indian FY into four quarters with the CMP-08 due date (18th of the next month)", () => {
    const q = compositionQuarters(2026);
    expect(q.map((x) => [x.key, x.from, x.to, x.due])).toEqual([
      ["Q1", "2026-04-01", "2026-06-30", "2026-07-18"],
      ["Q2", "2026-07-01", "2026-09-30", "2026-10-18"],
      ["Q3", "2026-10-01", "2026-12-31", "2027-01-18"],
      ["Q4", "2027-01-01", "2027-03-31", "2027-04-18"],
    ]);
    expect(q[0].label).toBe("Apr–Jun 2026");
    expect(q[3].label).toBe("Jan–Mar 2027");
  });

  it("GSTR-4 is due 30 June after the year (30 April before FY 2024-25)", () => {
    expect(gstr4DueDate(2026)).toBe("2027-06-30");
    expect(gstr4DueDate(2024)).toBe("2025-06-30");
    expect(gstr4DueDate(2023)).toBe("2024-04-30");
  });
});

describe("which documents count", () => {
  it("only issued composition Bills of Supply", () => {
    expect(isCompositionBill(bos("a", "2026-05-01", 100))).toBe(true);
    expect(isCompositionBill(bos("b", "2026-05-01", 100, { supplier_gst_status: "unregistered" }))).toBe(false);
    expect(isCompositionBill(bos("c", "2026-05-01", 100, { document_kind: "tax_invoice", supplier_gst_status: "registered" }))).toBe(false);
    expect(isCompositionBill(bos("d", "2026-05-01", 100, { status: "cancelled" }))).toBe(false);
    expect(isCompositionBill(bos("e", "2026-05-01", 100, { status: "draft" }))).toBe(false);
    for (const s of ["pending", "paid", "overdue"]) expect(isCompositionBill(bos("f", "2026-05-01", 1, { status: s }))).toBe(true);
  });

  it("value = taxable value, else the amount (a Bill of Supply carries no tax)", () => {
    expect(billOfSupplyValue(bos("a", "2026-05-01", 1000))).toBe(1000);
    expect(billOfSupplyValue({ ...bos("a", "2026-05-01", 1000), taxable_value: null })).toBe(1000);
  });
});

describe("cmp08Quarter", () => {
  const docs: CompositionDoc[] = [
    bos("a", "2026-04-01", 100000),
    bos("b", "2026-06-30", 50000),
    bos("c", "2026-07-01", 999999),                                   // next quarter
    bos("d", "2026-05-10", 70000, { supplier_gst_status: "unregistered" }), // before composition — not CMP-08
    bos("e", "2026-05-10", 30000, { document_kind: "tax_invoice", supplier_gst_status: "registered" }),
    bos("f", "2026-05-10", 40000, { status: "cancelled" }),
  ];
  const q1 = compositionQuarters(2026)[0];

  it("quarter turnover × composition rate, split CGST / SGST half each, whole rupees", () => {
    const r = cmp08Quarter({ docs, notes: [], rate: 6, quarter: q1 });
    expect(r.bills).toBe(2);
    expect(r.grossTurnover).toBe(150000);
    expect(r.netTurnover).toBe(150000);
    expect(r.cgst).toBe(4500);
    expect(r.sgst).toBe(4500);
    expect(r.tax).toBe(9000);
    expect(r.due).toBe("2026-07-18");
  });

  it("credit notes on composition bills reduce, debit notes add; notes on other bills ignored", () => {
    const notes: CompositionNote[] = [
      { kind: "credit", date: "2026-06-01", value: 10000, invoice: { document_kind: "bill_of_supply", supplier_gst_status: "composition" } },
      { kind: "debit", date: "2026-06-02", value: 2000, invoice: { document_kind: "bill_of_supply", supplier_gst_status: "composition" } },
      { kind: "credit", date: "2026-06-03", value: 5000, invoice: { document_kind: "tax_invoice", supplier_gst_status: "registered" } },
      { kind: "credit", date: "2026-07-03", value: 5000, invoice: { document_kind: "bill_of_supply", supplier_gst_status: "composition" } },
      { kind: "credit", date: "2026-06-04", value: 7000, invoice: { document_kind: "tax_invoice", supplier_gst_status: "composition" } },
      { kind: "credit", date: "2026-06-05", value: 3000, invoice: null },
    ];
    const r = cmp08Quarter({ docs, notes, rate: 6, quarter: q1 });
    expect(r.creditNotes).toBe(10000);
    expect(r.debitNotes).toBe(2000);
    expect(r.netTurnover).toBe(142000);
    expect(r.tax).toBe(8520);
  });

  it("rounds each head to the rupee (Section 170) and never goes below zero", () => {
    const odd = cmp08Quarter({ docs: [bos("x", "2026-04-02", 1234.5)], notes: [], rate: 1, quarter: q1 });
    expect(odd.cgst).toBe(6);      // 6.1725
    expect(odd.sgst).toBe(6);
    expect(odd.tax).toBe(12);

    const negative = cmp08Quarter({
      docs: [], rate: 6, quarter: q1,
      notes: [{ kind: "credit", date: "2026-05-01", value: 500, invoice: { document_kind: "bill_of_supply", supplier_gst_status: "composition" } }],
    });
    expect(negative.netTurnover).toBe(-500);
    expect(negative.tax).toBe(0);
  });

  it("refuses a rate outside the setting's range instead of reporting a wrong tax (fail closed)", () => {
    expect(() => cmp08Quarter({ docs, notes: [], rate: 0, quarter: q1 })).toThrow(/Composition rate/);
    expect(() => cmp08Quarter({ docs, notes: [], rate: Number.NaN, quarter: q1 })).toThrow(/Settings/);
    expect(() => cmp08Quarter({ docs, notes: [], rate: 12, quarter: q1 })).toThrow();
  });
});

describe("gstr4Year", () => {
  it("adds up the four quarters", () => {
    const docs = [
      bos("a", "2026-04-15", 100000), bos("b", "2026-08-15", 200000),
      bos("c", "2026-11-15", 300000), bos("d", "2027-03-31", 400000),
      bos("z", "2027-04-01", 5),      // next FY
    ];
    const y = gstr4Year({ docs, notes: [], rate: 6, fyStartYear: 2026 });
    expect(y.quarters.map((q) => q.netTurnover)).toEqual([100000, 200000, 300000, 400000]);
    expect(y.netTurnover).toBe(1000000);
    expect(y.cgst).toBe(30000);
    expect(y.sgst).toBe(30000);
    expect(y.tax).toBe(60000);
    expect(y.bills).toBe(4);
    expect(y.due).toBe("2027-06-30");
    expect(y.fyLabel).toBe("FY 2026-27");
  });

  it("the CSV has one row per quarter plus the GSTR-4 total, same headers count", () => {
    const y = gstr4Year({ docs: [bos("a", "2026-04-15", 100000)], notes: [], rate: 6, fyStartYear: 2026 });
    const rows = compositionCsv(y);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r).toHaveLength(COMPOSITION_CSV_HEADERS.length);
    expect(rows[0][0]).toBe("CMP-08 Q1 (Apr–Jun 2026)");
    expect(rows[4][0]).toBe("GSTR-4 FY 2026-27");
    expect(rows[4].at(-2)).toBe(6000);
  });
});
