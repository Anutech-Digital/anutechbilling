import { describe, expect, it } from "vitest";

import { toIstDate } from "@/lib/dates/ist";
import { paymentAdvances, snapshotAdvanceGross, type AdvanceContext, type AdvancePayment } from "./advance-cash";
import { buildAdvances, type Advance } from "./gstr1";

/* R-1565: ₹10,000 paid in advance in September on quote A (no invoice by month end) → 11A
   September. In October the customer's ₹10,000 credit pays quote B: record_desk_payment writes
   a payment of amount 10,000, credit_applied 10,000. No money came in in October — 11A October
   must not tax that ₹10,000 a second time. */
const seller = { stateCode: "07", state: "Delhi", gstin: "07AAAAA0000A1Z5" };
const ctx: AdvanceContext = {
  adjustedOn: null, rate: 18, interState: false,
  customerGstin: null, customerStateCode: "07", customerState: "Delhi", customerCountry: "India",
};
const sept: AdvancePayment = { id: "pay-sept", receipt_voucher_no: "RV-1", amount: 10_000, credit_applied: 0, received_at: "2026-09-10T05:00:00Z" };
const oct: AdvancePayment = { id: "pay-oct", receipt_voucher_no: "RV-2", amount: 10_000, credit_applied: 10_000, received_at: "2026-10-05T05:00:00Z" };
const SEPT = { from: "2026-09-01", to: "2026-09-30" };
const OCT = { from: "2026-10-01", to: "2026-10-31" };

const at11A = (advances: Advance[], period: { from: string; to: string }) =>
  buildAdvances(advances, period, seller).at.reduce((s, r) => s + r.advance, 0);

describe("GSTR-1 11A counts an advance once (R-1565)", () => {
  it("September reports the ₹10,000 advance (taxable ₹8,475)", () => {
    expect(at11A(paymentAdvances([sept], toIstDate, () => ctx), SEPT)).toBe(8_475);
  });

  it("October: credit applied to a payment is not a new advance", () => {
    expect(at11A(paymentAdvances([oct], toIstDate, () => ctx), OCT)).toBe(0);
  });

  it("part credit, part cash: only the cash is a new advance", () => {
    const mixed: AdvancePayment = { ...oct, id: "pay-mixed", amount: 6_000, credit_applied: 4_000 };
    expect(paymentAdvances([mixed], toIstDate, () => ctx)[0].gross).toBe(2_000);
  });

  it("11B adjusts only the cash part of an invoice's adjusted advance", () => {
    const credit = new Map([["pay-oct", 10_000], ["pay-mixed", 4_000]]);
    expect(snapshotAdvanceGross({ payment_id: "pay-oct", amount: 10_000 }, credit)).toBe(0);
    expect(snapshotAdvanceGross({ payment_id: "pay-mixed", amount: 6_000 }, credit)).toBe(2_000);
    expect(snapshotAdvanceGross({ payment_id: "pay-sept", amount: 10_000 }, credit)).toBe(10_000);
  });
});
