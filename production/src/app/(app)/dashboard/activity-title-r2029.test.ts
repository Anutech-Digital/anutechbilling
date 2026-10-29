// R-2029: an R-1863 / R-2023 customer advance (₹0 "Advance on account" holder quote, paid)
// showed on the dashboard as "Quote paid: Q-… · ₹0". It is the customer's advance.
import { describe, it, expect } from "vitest";
import { quoteActivityTitle } from "./activity-title";

const advance = {
  id: "Q-ADV-1", plan: "Advance on account", amount: 0, invoice_id: null, line_items: [],
  payment_status: "received", payment_amount: 47348, status: "accepted", customer_name: "Links Infotech",
};

describe("R-2029 dashboard recent activity — customer advance", () => {
  it("an advance reads 'Customer advance · ₹X' with the money received, not 'Quote paid ₹0'", () => {
    const t = quoteActivityTitle(advance);
    expect(t).not.toContain("Quote paid");
    expect(t).toMatch(/^Customer advance · /);
    expect(t).toContain("47");
    expect(t).toContain("Links Infotech");
  });

  it("a normal paid quote still reads 'Quote paid'", () => {
    const t = quoteActivityTitle({ ...advance, plan: "Microsoft 365", amount: 5000, line_items: [{}] });
    expect(t).toMatch(/^Quote paid: Q-ADV-1 · /);
  });

  it("an unpaid quote reads sent / created", () => {
    expect(quoteActivityTitle({ ...advance, plan: "X", amount: 10, payment_status: "pending", status: "sent" }))
      .toBe("Quote sent: Q-ADV-1 · Links Infotech");
  });
});
