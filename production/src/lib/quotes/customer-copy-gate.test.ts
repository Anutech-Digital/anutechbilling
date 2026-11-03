/* R-1669 — an approval-pending / rejected quote must not reach the customer (PDF, WhatsApp,
   PDF link, email); an approved or never-needed one, and an old sent quote, still may. */
import { describe, it, expect } from "vitest";
import { customerCopyBlock, type CustomerCopyQuote } from "./customer-copy-gate";

/* Q-5F40-27-0091: GW Standard, 10 seats, ₹10,627 against a ₹12,960 list = 18% off → manager. */
const discounted = [{ id: "l1", name: "GW Standard", qty: 10, rate: 10627, list_rate: 12960, cost: 8640, commitment: "annual_yearly" }];
const atList     = [{ id: "l1", name: "GW Standard", qty: 10, rate: 12960, list_rate: 12960, cost: 8640, commitment: "annual_yearly" }];

function q(over: Partial<CustomerCopyQuote>): CustomerCopyQuote {
  return {
    status: "draft", line_items: discounted as CustomerCopyQuote["line_items"],
    approval_status: "not_required", approval_tier: null, approval_requested_by: null, approved_by: null,
    approved_discount_bps: null, approved_margin_bps: null, approval_rejection_reason: null,
    ...over,
  };
}

describe("customerCopyBlock (R-1669)", () => {
  it("approval pending → blocked, with the reason", () => {
    const b = customerCopyBlock(q({ approval_status: "pending", approval_tier: "manager", approval_requested_by: "u1" }));
    expect(b).not.toBeNull();
    expect(b?.reason).toMatch(/approve/i);
  });

  it("approval rejected → blocked", () => {
    const b = customerCopyBlock(q({ approval_status: "rejected", approval_tier: "manager", approval_rejection_reason: "Too low" }));
    expect(b?.reason).toContain("Too low");
  });

  it("a draft that needs approval but was never sent for it → blocked", () => {
    expect(customerCopyBlock(q({}))).not.toBeNull();
  });

  it("approved for these numbers → allowed", () => {
    expect(customerCopyBlock(q({
      approval_status: "approved", approval_tier: "manager", approved_by: "u2", approved_discount_bps: 1800,
    }))).toBeNull();
  });

  it("no discount → allowed", () => {
    expect(customerCopyBlock(q({ line_items: atList as CustomerCopyQuote["line_items"] }))).toBeNull();
  });

  it("an older quote already sent before the matrix → its PDF is not pulled back", () => {
    expect(customerCopyBlock(q({ status: "sent" }))).toBeNull();
  });
});
