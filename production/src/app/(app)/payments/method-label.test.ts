import { describe, it, expect } from "vitest";
import { paymentMethodLabel } from "./method-label";

describe("paymentMethodLabel (R-177)", () => {
  it("shows bank_transfer as 'Bank transfer', never the raw code", () => {
    expect(paymentMethodLabel("bank_transfer")).toBe("Bank transfer");
  });
  it("keeps acronyms upper-case", () => {
    expect(paymentMethodLabel("upi")).toBe("UPI");
    expect(paymentMethodLabel("tds")).toBe("TDS");
  });
  it("turns an unknown code into words", () => {
    expect(paymentMethodLabel("demand_draft")).toBe("Demand draft");
  });
  it("shows a dash when there is no method", () => {
    expect(paymentMethodLabel(null)).toBe("—");
    expect(paymentMethodLabel("")).toBe("—");
  });
});
