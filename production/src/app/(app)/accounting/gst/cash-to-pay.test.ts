/**
 * R-394: the Accounting Overview "GST cash to pay" tile and the GST page headline are one
 * number — both go report rows → gstr3bFromReport → gstCashHeadline. Before, the tile was
 * cumulative output − input and the page was cash after the Rule 88A set-off.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { setOffItc } from "@/lib/gst/gstr3b";
import { gstCashHeadline, gstr3bFromReport, type GstReport, type InputRow, type OutputRow } from "./cash-to-pay";

const range = { from: "2026-09-01", to: "2026-09-30" };

function inv(id: string, taxable: number, gst: number, interState: boolean): OutputRow {
  return {
    invoiceId: id, invoiceDate: "2026-09-10", customerName: "Acme", customerGstin: "07AAAAA0000A1Z5",
    customerStateCode: "07", customerState: "Delhi", customerCountry: "India",
    amount: taxable + gst, taxableValue: taxable, gst, taxRate: 18, interState, docType: "invoice",
  };
}
function bill(id: string, h: { igst: number; cgst: number; sgst: number }): InputRow {
  return {
    source: "bill", id, date: "2026-09-12", vendor: "Disti", vendorGstin: "07BBBBB0000B1Z5",
    taxableValue: 10_000, gst: h.igst + h.cgst + h.sgst, ...h, category: "Licences", billNo: id,
  };
}
function report(outputRows: OutputRow[], inputRows: InputRow[], extra: Partial<GstReport> = {}): GstReport {
  return {
    outputRows, inputRows,
    outputTotal: outputRows.reduce((s, r) => s + r.taxableValue, 0),
    outputGST: outputRows.reduce((s, r) => s + r.gst, 0),
    inputTotal: inputRows.reduce((s, r) => s + r.taxableValue, 0),
    inputGST: inputRows.reduce((s, r) => s + r.gst, 0),
    blockedItc: { eligible: 0, blocked: 0, blockedByReason: [] },
    blocked17Heads: [], rcmRows: [],
    sellerStateCode: "07", sellerState: "Delhi", sellerGstin: "07CCCCC0000C1Z5",
    advances: [], lateCreditNotes: 0,
    ...extra,
  };
}

describe("gstCashHeadline — the number on the GST page AND the Overview tile", () => {
  it("is cash after the Rule 88A set-off, not output − input", () => {
    // Intra-state sale: CGST 900 + SGST 900. Credit is CGST 1,800 only — CGST credit can
    // never pay SGST, so SGST 900 is cash and CGST 900 is carried forward.
    const data = report([inv("i1", 10_000, 1_800, false)], [bill("b1", { igst: 0, cgst: 1_800, sgst: 0 })]);
    const hl = gstCashHeadline(gstr3bFromReport(data, range), 0);
    expect(data.outputGST - data.inputGST).toBe(0);   // what the old tile showed
    expect(hl.cash).toBe(900);
    expect(hl.amount).toBe(900);
    expect(hl.carryForward).toBe(900);
    expect(hl.state).toBe("to_pay");
    expect(hl.label).toBe("GST cash to pay");
    // …and it is exactly setOffItc's cash.
    const so = setOffItc({ igst: 0, cgst: 900, sgst: 900 }, { igst: 0, cgst: 1_800, sgst: 0 });
    expect(hl.cash).toBe(so.cash.igst + so.cash.cgst + so.cash.sgst);
  });

  it("subtracts GST already paid for the months", () => {
    const data = report([inv("i1", 10_000, 1_800, true)], [bill("b1", { igst: 800, cgst: 0, sgst: 0 })]);
    const g = gstr3bFromReport(data, range);
    expect(gstCashHeadline(g, 400)).toMatchObject({ state: "still_to_pay", label: "GST still to pay", cash: 1_000, left: 600, amount: 600, net: 600 });
    expect(gstCashHeadline(g, 1_200)).toMatchObject({ state: "overpaid", amount: 200, net: -200 });
    expect(gstCashHeadline(g, 1_000)).toMatchObject({ state: "nil", amount: 0, hint: "Nothing to pay in cash" });
  });

  it("shows the carried-forward credit when no cash is due", () => {
    const data = report([inv("i1", 10_000, 1_800, true)], [bill("b1", { igst: 5_000, cgst: 0, sgst: 0 })]);
    const hl = gstCashHeadline(gstr3bFromReport(data, range), 0);
    expect(hl).toMatchObject({ state: "credit", label: "GST credit", cash: 0, amount: 3_200, carryForward: 3_200, net: -3_200 });
    expect(hl.hint).toMatch(/carried forward/);
  });

  it("reverse-charge tax is cash too", () => {
    const data = report([], [], { rcmRows: [{ id: "e1", vendor: "AWS", date: "2026-09-02", amount: 10_000, tax: 1_800 }] });
    expect(gstCashHeadline(gstr3bFromReport(data, range), 0).cash).toBe(1_800);
  });

  it("no data yet reads as nothing to pay", () => {
    expect(gstCashHeadline(null, 0)).toMatchObject({ state: "nil", amount: 0, cash: 0, carryForward: 0 });
  });
});

describe("one computation, two screens (source)", () => {
  const read = (p: string) => readFileSync(join(__dirname, p), "utf8");
  const gstPage = read("page.tsx");
  const overview = read("../page.tsx");

  it("the GST page headline comes from gstCashHeadline(gstr3bFromReport(...))", () => {
    expect(gstPage).toMatch(/gstr3bFromReport\(data, range\)/);
    expect(gstPage).toMatch(/gstCashHeadline\(g3b,/);
    expect(gstPage).not.toMatch(/computeGstr3b\(/);
    expect(gstPage).not.toMatch(/g3b\.pay\.igst \+ g3b\.pay\.cgst/);
  });

  it("the Overview tile uses the same hook on the page's default range, not gstPayable", () => {
    expect(overview).toMatch(/useGstCashToPay\(gstRange\)/);
    expect(overview).toMatch(/gstDefaultRange\(\)/);
    expect(overview).toMatch(/gstRangeHref\(gstRange\)/);
    expect(overview).not.toMatch(/const gstDue = /);
    expect(overview).not.toMatch(/"GST to pay"/);
  });
});
