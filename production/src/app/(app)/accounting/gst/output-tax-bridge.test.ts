/**
 * R-521 (9 Oct 2026): every output-tax number on the GST page reconciles.
 *
 * ANUTECH, October 2026 (localhost): Output GST card ₹1,11,073 on ₹6,17,076 (12 invoices =
 * the GSTR-1 rows) but 3B / head-wise ₹1,12,930 on ₹6,27,396. The ₹1,857 / ₹10,320 gap is
 * three receipt vouchers received in October on quotes not yet invoiced (₹708 + ₹7,646 +
 * ₹3,823) — tax on advances, GSTR-1 Table 11A, part of 3B 3.1(a). The bridge names it.
 */
import { describe, it, expect } from "vitest";

import type { Advance } from "@/lib/gst/gstr1";
import { gstr3bRows } from "@/lib/gst/gstr3b";
import { gstCashHeadline, gstr3bFromReport, outputTaxBridge, type GstReport, type OutputRow } from "./cash-to-pay";

const october = { from: "2026-10-01", to: "2026-10-31" };

function inv(id: string, taxable: number, gst: number, interState: boolean): OutputRow {
  return {
    invoiceId: id, invoiceDate: "2026-10-07", customerName: "Buyer", customerGstin: interState ? "27AAPFU0939F1ZV" : "07AAACE1234F1Z5",
    customerStateCode: interState ? "27" : "07", customerState: interState ? "Maharashtra" : "Delhi", customerCountry: "India",
    amount: taxable + gst, taxableValue: taxable, gst, taxRate: 18, interState, docType: "invoice",
  };
}
function adv(voucherNo: string, gross: number, receivedDate: string, adjustedOn: string | null): Advance {
  return {
    paymentId: `p-${voucherNo}`, voucherNo, receivedDate, adjustedOn, gross, rate: 18, interState: false,
    customerGstin: null, customerStateCode: "07", customerState: "Delhi", customerCountry: "India",
  };
}
function report(outputRows: OutputRow[], advances: Advance[]): GstReport {
  return {
    outputRows, inputRows: [],
    outputTotal: outputRows.reduce((s, r) => s + r.taxableValue, 0),
    outputGST: outputRows.reduce((s, r) => s + r.gst, 0),
    inputTotal: 0, inputGST: 0,
    blockedItc: { eligible: 0, blocked: 0, blockedByReason: [] },
    blocked17Heads: [], rcmRows: [],
    sellerStateCode: "07", sellerState: "Delhi", sellerGstin: "07ABDCA0298H1ZP",
    advances, lateCreditNotes: 0,
  };
}

/* The ANUTECH October shape: intra-state + inter-state invoices totalling ₹6,17,076 /
   ₹1,11,073, three open advances, and one advance invoiced the same month (neither table). */
const anutechOctober = () => report(
  [inv("INV-intra", 169_556, 30_520, false), inv("INV-inter", 447_520, 80_553, true)],
  [
    adv("RV-0001", 708, "2026-10-01", "2026-10-01"),   // invoiced in October → not 11A
    adv("RV-0003", 708, "2026-10-01", null),
    adv("RV-0006", 7_646, "2026-10-02", null),
    adv("RV-0007", 3_823, "2026-10-02", null),
  ],
);

describe("outputTaxBridge — Output GST card → GSTR-3B, every rupee named", () => {
  it("ANUTECH Oct 2026: card ₹1,11,073 + tax on advances ₹1,857 = 3B ₹1,12,930", () => {
    const data = anutechOctober();
    const g3b = gstr3bFromReport(data, october);
    const b = outputTaxBridge(data, october, g3b);

    expect(b.card).toEqual({ taxable: 617_076, tax: 111_073 });
    const a = b.lines.find((l) => l.key === "advances_11a")!;
    expect(a.count).toBe(3);
    expect(a.taxable).toBe(10_320);                       // 600 + 6,480 + 3,240
    expect(a.tax).toBe(1_857);
    expect(a.heads).toEqual({ igst: 0, cgst: 929, sgst: 928 });
    expect(a.items!.map((i) => i.ref)).toEqual(["RV-0003", "RV-0006", "RV-0007"]);
    expect(a.items!.map((i) => i.taxable)).toEqual([600, 6_480, 3_240]);

    expect(b.gstr3b.taxable).toBe(627_396);
    expect(b.gstr3b.tax).toBe(112_930);
    expect(b.total.tax).toBe(b.gstr3b.tax);
    expect(b.total.taxable).toBe(b.gstr3b.taxable);
    expect(b.total.heads).toEqual(b.gstr3b.heads);
    expect(b.difference).toBe(0);
    expect(b.card.tax + a.tax).toBe(b.gstr3b.tax);

    // the head-wise set-off and the headline read the same 3B: no input credit → cash = 3B tax
    expect(gstCashHeadline(g3b, 0).cash).toBe(112_930);
    expect(g3b.adv11a).toEqual({ taxable: 10_320, heads: { igst: 0, cgst: 929, sgst: 928 } });
  });

  it("the 3B worksheet names the advance part of 3.1(a)", () => {
    const rows = gstr3bRows(gstr3bFromReport(anutechOctober(), october));
    const named = rows.find((r) => String(r[1]).includes("Table 11A"));
    expect(named).toEqual(["—", "of 3.1(a): tax on advances received, not yet invoiced (GSTR-1 Table 11A)", 10_320, 0, 929, 928]);
    expect(rows[0][0]).toBe("3.1(a)");
    expect(rows[1]).toBe(named);
  });

  it("an earlier advance adjusted on this month's invoice (11B) is a named deduction", () => {
    const data = report(
      [inv("INV-1", 10_000, 1_800, false)],
      [adv("RV-SEP", 1_180, "2026-09-25", "2026-10-07")],
    );
    const g3b = gstr3bFromReport(data, october);
    const b = outputTaxBridge(data, october, g3b);
    const l = b.lines.find((x) => x.key === "advances_11b")!;
    expect(l.count).toBe(1);
    expect(l.taxable).toBe(-1_000);
    expect(l.tax).toBe(-180);
    expect(b.total.tax).toBe(1_620);
    expect(b.gstr3b.tax).toBe(1_620);
    expect(b.difference).toBe(0);
    expect(gstr3bRows(g3b).some((r) => String(r[1]).includes("Table 11B") && r[2] === -1_000 && r[4] === -90)).toBe(true);
  });

  it("no advances → no advance rows, card = 3B", () => {
    const data = report([inv("INV-1", 10_000, 1_800, true)], []);
    const g3b = gstr3bFromReport(data, october);
    const b = outputTaxBridge(data, october, g3b);
    expect(b.lines.filter((l) => l.key.startsWith("advances")).every((l) => l.count === 0 && l.tax === 0)).toBe(true);
    expect(b.card.tax).toBe(b.gstr3b.tax);
    expect(gstr3bRows(g3b).some((r) => String(r[1]).includes("Table 11"))).toBe(false);
  });

  it("credit notes net the card and the bridge alike", () => {
    const cn: OutputRow = { ...inv("CN-1", -2_000, -360, false), docType: "credit_note" };
    const data = report([inv("INV-1", 10_000, 1_800, false), cn], []);
    const b = outputTaxBridge(data, october, gstr3bFromReport(data, october));
    expect(b.lines.find((l) => l.key === "credit_notes")!.tax).toBe(-360);
    expect(b.card.tax).toBe(1_440);
    expect(b.difference).toBe(0);
  });
});
