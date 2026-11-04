/**
 * R-2344 — Q-F588-27-0070 (localhost, 1 Nov): below cost, owner approval pending. After "Mark
 * accepted" the money row still offered "Invoice now (before payment)" and "Activate now, pay
 * later", and the server took both on credit. The DB now refuses them (migration
 * 20261101062059 — invoices / subscriptions triggers, same rule as R-2213's payments trigger), so
 * the page must not offer them while the block holds: the step box says why and offers
 * "Open approval". "Mark accepted" stays. Approved / not-below-cost quotes, part payment requests
 * (R-2054) and quotes with money already in look as before.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { quoteMoneyActions, APPROVAL_WAIT_NOTE } from "@/lib/quotes/money-stage";
import { belowCostRefusal, paymentApprovalBlock } from "@/lib/quotes/payment-approval";
import { activateOnCreditBlock } from "./payment-approval-gate";

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const q = { id: "Q-F588-27-0070" };

const accepted = (approvalWait: boolean, extra: Record<string, unknown> = {}) =>
  quoteMoneyActions(
    { status: "accepted", paymentStatus: "none", invoiceId: null, total: 1180, received: 0, approvalWait, ...extra },
    rupees,
  );

describe("Invoice now on a below-cost quote waiting for the owner (R-2344)", () => {
  it("accepted + pending: no Invoice now, the owner-approval line + Open approval instead", () => {
    const m = accepted(true);
    expect(m.canGenerateInvoice).toBe(false);
    expect(m.canRecordPayment).toBe(false);
    expect(m.openApproval).toBe(true);
    expect(m.note).toBe(APPROVAL_WAIT_NOTE);
    expect(APPROVAL_WAIT_NOTE).toMatch(/invoice/i);
    expect(APPROVAL_WAIT_NOTE).toMatch(/pay later/i);
  });

  it("approved / not below cost → Invoice now as today", () => {
    expect(accepted(false).canGenerateInvoice).toBe(true);
  });

  it("money already in (Razorpay) → its invoice is still offered, like the server", () => {
    const m = quoteMoneyActions(
      { status: "accepted", paymentStatus: "received", invoiceId: null, total: 1180, received: 1180, approvalWait: true },
      rupees,
    );
    expect(m.canGenerateInvoice).toBe(true);
  });

  it("part payment request (R-2054) unchanged", () => {
    expect(accepted(true, { partRequest: true })).toEqual(accepted(false, { partRequest: true }));
  });
});

describe("Activate now, pay later while the owner has not approved (R-2344)", () => {
  it("blocked with the server's own words", () => {
    const b = activateOnCreditBlock({ ...q, below_cost: true, approval_status: "pending" });
    expect(b?.reason).toBe(belowCostRefusal(q.id, "activate it"));
    expect(b?.reason).toBe(
      "This quote is below cost and waits for the owner's approval. Approve it first (Quotes → Q-F588-27-0070 → Approve), then activate it.",
    );
  });

  it("approved, not below cost, or a part payment request → not blocked", () => {
    expect(activateOnCreditBlock({ ...q, below_cost: true, approval_status: "approved" })).toBeNull();
    expect(activateOnCreditBlock({ ...q, below_cost: false, approval_status: "pending" })).toBeNull();
    expect(activateOnCreditBlock({ ...q, below_cost: true, approval_status: "pending", subscription_billing_id: "b1" })).toBeNull();
    expect(paymentApprovalBlock({ ...q, below_cost: true, approval_status: "pending", subscription_billing_id: "b1" })).toBeNull();
  });

  it("the payment refusal keeps R-2213's text", () => {
    expect(belowCostRefusal(q.id)).toBe(
      "This quote is below cost and waits for the owner's approval. Approve it first (Quotes → Q-F588-27-0070 → Approve), then record the payment.",
    );
  });
});

describe("quote page wiring (R-2344)", () => {
  const page = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
  it("Activate now, pay later (menu and action row) is gated by activateOnCreditBlock", () => {
    expect(page).toMatch(/activateOnCreditBlock\(/);
    expect(page).toMatch(/creditBlock/);
  });
  it("Mark accepted is not gated by the approval block", () => {
    const i = page.indexOf("mark-accepted");
    expect(i).toBeGreaterThan(-1);
    expect(page.slice(Math.max(0, i - 400), i)).not.toMatch(/payBlock|creditBlock/);
  });
});
