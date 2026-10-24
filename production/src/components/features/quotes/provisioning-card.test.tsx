/**
 * R-1689 — the "Setting up" box said "This quote is paid." on an unpaid quote (Q-F588-27-0018,
 * activated before payment). Its first line now comes from the quote's money (R-1710).
 */
import { describe, it, expect } from "vitest";
import { quotePaymentState } from "@/lib/quotes/quote-payment-state";
import { setupBoxLine } from "./provisioning-card";

describe("setupBoxLine (R-1689)", () => {
  it("an accepted, unpaid quote is NOT called paid", () => {
    const line = setupBoxLine(quotePaymentState({ payment_status: "pending", amount: 44132, payment_amount: 0 }), 1);
    expect(line).not.toMatch(/is paid/i);
    expect(line).toBe("Not paid yet — set up before payment. 1 product to set up.");
  });

  it("invoiced on credit with nothing in is not paid either", () => {
    const line = setupBoxLine(quotePaymentState({ payment_status: "invoiced", amount: 44132, payment_amount: 0 }), 2);
    expect(line).not.toMatch(/is paid/i);
    expect(line).toMatch(/2 products to set up/);
  });

  it("part paid says both halves", () => {
    const line = setupBoxLine(quotePaymentState({ payment_status: "partial", amount: 38232, payment_amount: 20000 }), 1);
    expect(line).toBe("Part paid — ₹20,000 received · ₹18,232 still due. 1 product to set up.");
  });

  it("paid in full says paid", () => {
    expect(setupBoxLine(quotePaymentState({ payment_status: "received", amount: 38232, payment_amount: 38232 }), 1))
      .toBe("This quote is paid. 1 product to set up.");
  });

  it("quote not read yet → no claim about payment", () => {
    expect(setupBoxLine(null, 0)).toBe("Nothing on it looks like a product that needs setting up.");
  });
});
