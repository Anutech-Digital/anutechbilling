// R-449: payment references in the format each method really uses.
import { describe, it, expect } from "vitest";
import { paymentRefProblem } from "./poka-yoke";

describe("paymentRefProblem (R-449)", () => {
  it("UPI: exactly 12 digits", () => {
    expect(paymentRefProblem("upi", "402312345678")).toBeNull();
    expect(paymentRefProblem("upi", "4023 1234 5678")).toBeNull();
    expect(paymentRefProblem("upi", "12345")).toBe("A UPI reference is 12 digits — this has 5.");
    expect(paymentRefProblem("upi", "40231234567X")).toBe("A UPI reference is 12 digits, numbers only.");
  });
  it("bank transfer: 12 to 22 letters and digits (IMPS / NEFT / RTGS)", () => {
    expect(paymentRefProblem("bank_transfer", "N281241234567890")).toBeNull();      // NEFT 16
    expect(paymentRefProblem("bank_transfer", "402312345678")).toBeNull();          // IMPS 12
    expect(paymentRefProblem("bank_transfer", "HDFCR52026100912345678")).toBeNull(); // RTGS 22
    expect(paymentRefProblem("bank_transfer", "12345")).toMatch(/12 to 22/);
  });
  it("other methods have no format rule here", () => {
    expect(paymentRefProblem("cheque", "004521 SBI")).toBeNull();
    expect(paymentRefProblem("cash", "")).toBeNull();
  });
});
