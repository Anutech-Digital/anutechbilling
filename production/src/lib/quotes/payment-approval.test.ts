/* R-2213 — below-cost approval: the server writes the state, the money guard and the status label read it. */
import { describe, expect, it } from "vitest";
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { belowCostRefusal, linesBelowCost, paymentApprovalBlock, serverApprovalColumns } from "./payment-approval";
import { unifiedStatus } from "./status-badge";

const line = (o: Partial<QuoteLineItem>): QuoteLineItem =>
  ({ id: "add-seats-1", name: "Google Workspace Business Standard · +3 seats", qty: 3, rate: 500, cost: 600, commitment: "annual_yearly", ...o }) as QuoteLineItem;

describe("R-2213 serverApprovalColumns (Manage seats writes the approval the quote page shows)", () => {
  it("below cost (the staging Q-0429 shape: 3 × ₹500 against ₹600 cost) → pending, owner, below_cost", () => {
    const c = serverApprovalColumns([line({})], "u-owner", "2026-07-10T10:00:00.000Z");
    expect(c).toEqual({
      approval_status: "pending", approval_tier: "owner", approval_requested_by: "u-owner",
      approval_requested_at: "2026-07-10T10:00:00.000Z", below_cost: true,
    });
  });
  it("thin margin (5%) → pending for the owner, but NOT below cost (money is not blocked)", () => {
    const c = serverApprovalColumns([line({ rate: 1000, cost: 950 })], "u1");
    expect(c.approval_status).toBe("pending");
    expect(c.below_cost).toBe(false);
  });
  it("unknown cost → pending (owner), not below cost", () => {
    const c = serverApprovalColumns([line({ cost: 0 })], "u1");
    expect(c.approval_status).toBe("pending");
    expect(c.below_cost).toBe(false);
    expect(linesBelowCost([line({ cost: 0 })])).toBe(false);
  });
  it("healthy margin → not_required, nothing requested", () => {
    expect(serverApprovalColumns([line({ rate: 1000, cost: 700 })], "u1")).toEqual({
      approval_status: "not_required", approval_tier: null, approval_requested_by: null, approval_requested_at: null, below_cost: false,
    });
  });
});

describe("R-2213 paymentApprovalBlock (same rule as the DB trigger)", () => {
  it("below cost + pending → refused with the DB's words", () => {
    expect(paymentApprovalBlock({ id: "Q-1", below_cost: true, approval_status: "pending" })).toEqual({
      reason: "This quote is below cost and waits for the owner's approval. Approve it first (Quotes → Q-1 → Approve), then record the payment.",
    });
    expect(belowCostRefusal("Q-1")).toContain("Quotes → Q-1 → Approve");
  });
  it("below cost + rejected → still refused; approved → paid", () => {
    expect(paymentApprovalBlock({ id: "Q-1", below_cost: true, approval_status: "rejected" })).not.toBeNull();
    expect(paymentApprovalBlock({ id: "Q-1", below_cost: true, approval_status: "approved" })).toBeNull();
  });
  it("pending but not below cost → not blocked", () => {
    expect(paymentApprovalBlock({ id: "Q-1", below_cost: false, approval_status: "pending" })).toBeNull();
  });
});

describe("R-2213 status label: a quote waiting on approval never reads 'Sent'", () => {
  const base = { status: "sent" as const, payment_status: "awaiting" as const, amount: 1770, payment_amount: 0, expires_date: "2099-01-01" };
  it("sent + pending approval → Needs approval", () => {
    expect(unifiedStatus({ ...base, approval_status: "pending" }, "2026-07-12").label).toBe("Needs approval");
  });
  it("sent + below cost, not approved → Needs approval", () => {
    expect(unifiedStatus({ ...base, approval_status: "not_required", below_cost: true }, "2026-07-12").label).toBe("Needs approval");
  });
  it("sent + approved → Sent, as before", () => {
    expect(unifiedStatus({ ...base, approval_status: "approved", below_cost: true }, "2026-07-12").label).toBe("Sent");
  });
  it("money already in wins (Payment received stays)", () => {
    expect(unifiedStatus({ ...base, payment_status: "received", approval_status: "pending" }, "2026-07-12").label).not.toBe("Needs approval");
  });
});
