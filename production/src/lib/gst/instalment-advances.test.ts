import { describe, expect, it } from "vitest";

import { toIstDate } from "@/lib/dates/ist";
import type { AdvanceContext, AdvancePayment } from "./advance-cash";
import { buildAdvances, type Advance } from "./gstr1";
import { allocateInstalmentPayments, splitPaymentAdvances, type InstalmentInvoice } from "./instalment-advances";

/* R-1611: a quarterly split-billed subscription. Its quote never gets an invoice of its own
   (raise_subscription_billing leaves invoices.quote_id NULL — the link is
   subscription_billings.invoice_id). accounting/gst/report.ts took an advance's adjusted date
   only from quotes.invoice_id, so money paid ON a raised instalment invoice
   (record_instalment_payment, R-1564) stayed an "unadjusted advance" in 11A for ever. */
const seller = { stateCode: "07", state: "Delhi", gstin: "07AAAAA0000A1Z5" };
const ctx: AdvanceContext = {
  adjustedOn: null, rate: 18, interState: false,
  customerGstin: null, customerStateCode: "07", customerState: "Delhi", customerCountry: "India",
};
const OCT = { from: "2026-10-01", to: "2026-10-31" };
const NOV = { from: "2026-11-01", to: "2026-11-30" };

const at11A = (advances: Advance[], period: { from: string; to: string }) =>
  buildAdvances(advances, period, seller).at.reduce((s, r) => s + r.advance, 0);
const at11B = (advances: Advance[], period: { from: string; to: string }) =>
  buildAdvances(advances, period, seller).atadj.reduce((s, r) => s + r.advance, 0);

const pay = (id: string, amount: number, at: string, credit = 0): AdvancePayment =>
  ({ id, receipt_voucher_no: `RV-${id}`, amount, credit_applied: credit, received_at: at });

function advances(pays: AdvancePayment[], inst: InstalmentInvoice[]): Advance[] {
  const portions = allocateInstalmentPayments(pays, inst);
  return splitPaymentAdvances(pays, toIstDate, () => ctx, (p) => portions.get(p.id));
}

describe("GSTR-1 11A: payment on a raised instalment invoice is not an advance (R-1611)", () => {
  // Q1 instalment invoice ₹2,360 raised 5 Oct; ₹2,360 paid on it 10 Oct.
  const q1: InstalmentInvoice = { id: "INV-Q1", invoiceDate: "2026-10-05", applied: 2_360 };

  it("payment applied to an instalment invoice raised in the same month → 11A 0", () => {
    expect(at11A(advances([pay("p1", 2_360, "2026-10-10T05:00:00Z")], [q1]), OCT)).toBe(0);
  });

  it("part payment ₹1,000 on the ₹2,360 instalment → 11A 0 (applied, not advance)", () => {
    const part = { ...q1, applied: 1_000 };
    expect(at11A(advances([pay("p1", 1_000, "2026-10-10T05:00:00Z")], [part]), OCT)).toBe(0);
  });

  it("a real advance (nothing raised yet) stays in 11A", () => {
    expect(at11A(advances([pay("p1", 2_360, "2026-10-10T05:00:00Z")], []), OCT)).toBe(2_000);
  });

  it("money over the instalment's due stays an advance — only the excess", () => {
    // ₹3,000 paid, Q1 took ₹2,360 → ₹640 waits for the next instalment.
    const a = advances([pay("p1", 3_000, "2026-10-10T05:00:00Z")], [q1]);
    expect(a.reduce((s, x) => s + x.gross, 0)).toBe(3_000);
    expect(at11A(a, OCT)).toBe(542); // 640 × 100/118
  });

  it("advance in October, instalment raised in November takes it → 11A Oct, 11B Nov", () => {
    const q2: InstalmentInvoice = { id: "INV-Q2", invoiceDate: "2026-11-05", applied: 2_360 };
    const a = advances([pay("p1", 2_360, "2026-10-20T05:00:00Z")], [q2]);
    expect(at11A(a, OCT)).toBe(2_000);
    expect(at11B(a, NOV)).toBe(2_000);
  });

  it("oldest money fills the oldest instalment first", () => {
    const q2: InstalmentInvoice = { id: "INV-Q2", invoiceDate: "2026-11-05", applied: 1_000 };
    const pays = [pay("p2", 2_000, "2026-10-12T05:00:00Z"), pay("p1", 2_360, "2026-10-10T05:00:00Z")];
    const portions = allocateInstalmentPayments(pays, [q1, q2]);
    expect(portions.get("p1")).toEqual([{ gross: 2_360, adjustedOn: "2026-10-05", invoiceId: "INV-Q1" }]);
    expect(portions.get("p2")).toEqual([
      { gross: 1_000, adjustedOn: "2026-11-05", invoiceId: "INV-Q2" },
      { gross: 1_000, adjustedOn: null, invoiceId: null },
    ]);
  });

  it("advance credit inside a payment is never taxed again — portions carry the cash share", () => {
    // ₹2,360 settled = ₹1,180 cash + ₹1,180 credit, all applied to Q1.
    const portions = allocateInstalmentPayments([pay("p1", 2_360, "2026-10-10T05:00:00Z", 1_180)], [q1]);
    expect(portions.get("p1")).toEqual([{ gross: 1_180, adjustedOn: "2026-10-05", invoiceId: "INV-Q1" }]);
  });
});
