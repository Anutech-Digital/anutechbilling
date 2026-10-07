/**
 * R-399: the money inbox "GST & Tax" folder, the Overview GST tile and the GST page headline
 * are ONE number. Before, the folder printed the cumulative output − input (gstPayable,
 * "All to date") while the tile and the page printed cash after the Rule 88A set-off for the
 * return period (R-394). The folder now takes gstCashHeadline's `net` via gstInboxFields and
 * links to the tile's own range.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { gstFolderState, gstInboxFields, moneyInboxState } from "@/lib/accounting/money-inbox";
import { gstCashHeadline, gstr3bFromReport, type GstReport, type InputRow, type OutputRow } from "./gst/cash-to-pay";
import { gstRangeHref } from "./gst/range";

const range = { from: "2026-09-01", to: "2026-09-30", label: "Sep 2026" };

function inv(id: string, taxable: number, gst: number): OutputRow {
  return {
    invoiceId: id, invoiceDate: "2026-09-10", customerName: "Acme", customerGstin: "07AAAAA0000A1Z5",
    customerStateCode: "07", customerState: "Delhi", customerCountry: "India",
    amount: taxable + gst, taxableValue: taxable, gst, taxRate: 18, interState: false, docType: "invoice",
  };
}
function bill(id: string, h: { igst: number; cgst: number; sgst: number }): InputRow {
  return {
    source: "bill", id, date: "2026-09-12", vendor: "Disti", vendorGstin: "07BBBBB0000B1Z5",
    taxableValue: 10_000, gst: h.igst + h.cgst + h.sgst, ...h, category: "Licences", billNo: id,
  };
}
function report(outputRows: OutputRow[], inputRows: InputRow[]): GstReport {
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
  };
}
const folderFor = (data: GstReport, paid: number) => {
  const hl = gstCashHeadline(gstr3bFromReport(data, range), paid);
  const empty = { receivables: [], unmatchedCredits: [], billsDue: [] };
  return { hl, folder: moneyInboxState({ ...empty, ...gstInboxFields(hl, range.label) }).gst };
};

describe("GST folder = GST tile = GST page headline", () => {
  it("cash after the Rule 88A set-off, not output − input", () => {
    // CGST 900 + SGST 900 out; CGST 1,800 in. Output − input = 0 (the old folder: ₹0),
    // but CGST credit cannot pay SGST, so ₹900 is cash to pay.
    const data = report([inv("i1", 10_000, 1_800)], [bill("b1", { igst: 0, cgst: 1_800, sgst: 0 })]);
    const { hl, folder } = folderFor(data, 0);
    expect(data.outputGST - data.inputGST).toBe(0);
    expect(hl.amount).toBe(900);
    expect(folder.amount).toBe(hl.amount);
    expect(folder.urgent).toBe(true);
    expect(folder.urgentReason).toMatch(/Sep 2026/);
    expect(folder.urgentReason).toMatch(/20th/);
  });

  it("GST already paid is taken off, same as the tile", () => {
    const data = report([inv("i1", 10_000, 1_800)], []);
    const { hl, folder } = folderFor(data, 500);
    expect(hl.state).toBe("still_to_pay");
    expect(folder.amount).toBe(hl.amount);
    expect(folder.amount).toBe(1_300);
  });

  it("credit carried forward: same amount as the tile, not urgent, says it carries forward", () => {
    const data = report([], [bill("b1", { igst: 0, cgst: 700, sgst: 700 })]);
    const { hl, folder } = folderFor(data, 0);
    expect(hl.state).toBe("credit");
    expect(folder.amount).toBe(hl.amount);
    expect(folder.urgent).toBe(false);
    expect(folder.urgentReason).toMatch(/carries forward/);
  });

  it("overpaid: says paid more than due, never 'credit exceeds output tax'", () => {
    const data = report([inv("i1", 10_000, 1_800)], []);
    const { hl, folder } = folderFor(data, 2_000);
    expect(hl.state).toBe("overpaid");
    expect(folder.amount).toBe(hl.amount);
    expect(folder.amount).toBe(200);
    expect(folder.urgent).toBe(false);
    expect(folder.urgentReason).toMatch(/more than the cash due/);
    expect(folder.urgentReason).not.toMatch(/Input credit exceeds/);
  });

  it("no headline yet (loading / no data) reads as nothing to pay", () => {
    expect(gstFolderState(gstInboxFields(null, range.label).gstNet).amount).toBe(0);
  });
});

describe("the Overview page wires the folder to the tile, not to gstPayable", () => {
  const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

  it("feeds the inbox from the GST headline", () => {
    expect(src).toMatch(/gstInboxFields\(gstHl, gstRange\.label\)/);
    expect(src).not.toMatch(/gstNet:\s*autoQ\.data\?\.gstPayable/);
  });

  it("links the folder to the tile's range, not 'All to date'", () => {
    expect(src).toMatch(/f\.id === "gst" \? \{ \.\.\.f, href: gstTileHref \}/);
    expect(src).not.toMatch(/gstAllToDateHref/);
    expect(gstRangeHref(range)).toBe("/accounting/gst?from=2026-09-01&to=2026-09-30");
  });
});
