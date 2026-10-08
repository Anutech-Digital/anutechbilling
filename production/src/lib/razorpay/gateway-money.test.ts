import { describe, it, expect } from "vitest";
import { gatewayFeeFromPayment, parseRefund, refundAdvice } from "./gateway-money";

describe("gatewayFeeFromPayment — paise to whole rupees, nothing lost in rounding", () => {
  it("₹1,180 card payment, fee ₹27.86 incl. ₹4.25 GST", () => {
    expect(gatewayFeeFromPayment({ amount: 118000, fee: 2786, tax: 425 })).toEqual({ fee: 28, gst: 4, feeExGst: 24, net: 1152 });
  });
  it("base + GST = fee, and net + fee = amount, for awkward paise", () => {
    for (const [amount, fee, tax] of [[99999, 2351, 359], [1050, 50, 50], [100, 0, 0], [123456, 2913, 444]]) {
      const r = gatewayFeeFromPayment({ amount, fee, tax })!;
      expect(r.feeExGst + r.gst).toBe(r.fee);
      expect(r.net + r.fee).toBe(Math.round(amount / 100));
      expect(Number.isInteger(r.fee) && Number.isInteger(r.gst) && Number.isInteger(r.net)).toBe(true);
    }
  });
  it("tax missing: zero GST, fee still known", () => {
    expect(gatewayFeeFromPayment({ amount: 10000, fee: 200 })).toEqual({ fee: 2, gst: 0, feeExGst: 2, net: 98 });
  });
  it("untrustworthy numbers give null (unknown), never a guessed zero", () => {
    expect(gatewayFeeFromPayment(null)).toBeNull();
    expect(gatewayFeeFromPayment({ amount: 10000 })).toBeNull();
    expect(gatewayFeeFromPayment({ amount: 10000, fee: -1 })).toBeNull();
    expect(gatewayFeeFromPayment({ amount: 10000, fee: 100, tax: 200 })).toBeNull();
    expect(gatewayFeeFromPayment({ amount: 100, fee: 200, tax: 0 })).toBeNull();
    expect(gatewayFeeFromPayment({ amount: 10000, fee: Number.NaN })).toBeNull();
  });
});

describe("parseRefund", () => {
  it("accepts a Razorpay refund entity", () => {
    expect(parseRefund({ id: "rfnd_1", payment_id: "pay_1", amount: 500, status: "processed" }))
      .toMatchObject({ id: "rfnd_1", payment_id: "pay_1", amount: 500 });
  });
  it("rejects missing ids, non-rfnd ids and non-positive amounts", () => {
    expect(parseRefund(undefined)).toBeNull();
    expect(parseRefund({ id: "x_1", payment_id: "pay_1", amount: 500 })).toBeNull();
    expect(parseRefund({ id: "rfnd_1", amount: 500 })).toBeNull();
    expect(parseRefund({ id: "rfnd_1", payment_id: "pay_1", amount: 0 })).toBeNull();
    expect(parseRefund({ id: "rfnd_1", payment_id: "pay_1", amount: "500" })).toBeNull();
  });
});

describe("refundAdvice — words only, a human books it", () => {
  const r = { id: "rfnd_1", payment_id: "pay_1", amount: 118000 };
  it("invoiced: credit note first, names the invoice", () => {
    const a = refundAdvice(r, { quoteId: "Q-1", paymentAmount: 1180, paymentStatus: "received", invoiceNumber: "INV-9" });
    expect(a.partial).toBe(false);
    expect(a.nextStep).toMatch(/credit note/);
    expect(a.nextStep).toContain("INV-9");
    expect(a.note).toContain("rfnd_1");
    expect(a.note).toContain("Nothing has been issued automatically");
  });
  it("not invoiced, full: Refund on the payment", () => {
    const a = refundAdvice(r, { quoteId: "Q-1", paymentAmount: 1180, paymentStatus: "received", invoiceNumber: null });
    expect(a.nextStep).toMatch(/Refund on that payment/);
  });
  it("partial without invoice: by hand, with both amounts", () => {
    const a = refundAdvice({ ...r, amount: 50000 }, { quoteId: "Q-1", paymentAmount: 1180, paymentStatus: "received", invoiceNumber: null });
    expect(a.partial).toBe(true);
    expect(a.amount).toBe(500);
    expect(a.note).toContain("₹500");
    expect(a.note).toContain("₹1,180");
  });
  it("already refunded in the app: nothing more to book", () => {
    const a = refundAdvice(r, { quoteId: "Q-1", paymentAmount: 1180, paymentStatus: "refunded", invoiceNumber: "INV-9" });
    expect(a.nextStep).toMatch(/already marked refunded/);
  });
});
