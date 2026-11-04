/**
 * R-2095 (30 Oct 2026, September reconcile): Record payment refused a real Razorpay payment id
 * that has no digit (pay_TgEaESviwlEIRM) — "Enter a real UTR / transaction ID (letters + digits)".
 * A Razorpay id is pay_ + 14 letters/digits; that is its whole rule.
 */
import { describe, it, expect } from "vitest";
import { paymentRefProblem } from "./poka-yoke";
import { recordPaymentSchema } from "@/components/features/quotes/record-payment-dialog";

const rp = { amount: 1000, receivedDate: "2026-09-01", tdsDeducted: false, tdsSection: "194J", tdsRatePct: 10 };

describe("R-2095 Razorpay payment id", () => {
  it("pay_ + 14 letters/digits passes, even with no digit", () => {
    expect(paymentRefProblem("razorpay", "pay_TgEaESviwlEIRM")).toBeNull();
    expect(paymentRefProblem("razorpay", "pay_P1a2B3c4D5e6F7")).toBeNull();
    expect(recordPaymentSchema.safeParse({ ...rp, method: "razorpay", reference: "pay_TgEaESviwlEIRM" }).success).toBe(true);
  });
  it("anything else is refused with the format", () => {
    expect(paymentRefProblem("razorpay", "pay_123")).toMatch(/pay_ followed by 14/);
    expect(recordPaymentSchema.safeParse({ ...rp, method: "razorpay", reference: "TgEaESviwlEIRM" }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ ...rp, method: "razorpay", reference: "dfg" }).success).toBe(false);
  });
});
