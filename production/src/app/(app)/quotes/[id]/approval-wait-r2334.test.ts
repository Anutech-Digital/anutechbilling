/**
 * R-2334 — Q-F588-27-0070 (localhost, 31 Oct, after R-2326): below cost, approval pending. The
 * header said "Needs approval" and Record payment showed the reason, but the step box still said
 * "Waiting on the customer. You can still record a payment if money arrives before they formally
 * accept." and the progress line read Sent ✓ → Signed. One screen, two different next steps.
 *
 * The block is R-2326's (recordPaymentBlock → paymentApprovalBlock, the DB trigger's rule) — never
 * a new rule. While it holds: the step box says "Waiting for the owner's approval" with Open
 * approval (no Record payment), and the progress line has an Owner approval step as the current
 * one. Approved / not-below-cost quotes and part payment requests (R-2054) look as before.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { quoteMoneyActions, APPROVAL_WAIT_NOTE } from "@/lib/quotes/money-stage";
import { quoteLifecycle } from "@/lib/quotes/lifecycle";
import { recordPaymentBlock, withApprovalStep } from "./payment-approval-gate";

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const quote = { id: "Q-F588-27-0070" };
const pending = recordPaymentBlock({ ...quote, below_cost: true, approval_status: "pending" });
const approved = recordPaymentBlock({ ...quote, below_cost: true, approval_status: "approved" });
const notBelow = recordPaymentBlock({ ...quote, below_cost: false, approval_status: "pending" });

const sentMoney = (approvalWait: boolean, extra: Record<string, unknown> = {}) =>
  quoteMoneyActions(
    { status: "sent", paymentStatus: "awaiting", invoiceId: null, total: 1180, received: 0, approvalWait, ...extra },
    rupees,
  );

const lifecycleSteps = (status: "sent" | "accepted" | "rejected" = "sent") =>
  quoteLifecycle({
    status, paymentStatus: "awaiting", invoiceId: null, hasSignature: false,
    provisionStatus: "pending", paid: false,
  });

describe("step box on a below-cost quote waiting for the owner (R-2334)", () => {
  it("Q-F588-27-0070 (sent, pending): waits for the owner — no customer/payment line, no Record payment", () => {
    expect(pending).not.toBeNull();
    const m = sentMoney(Boolean(pending));
    expect(m.note).toBe(APPROVAL_WAIT_NOTE);
    expect(m.note).toMatch(/^Waiting for the owner's approval/);
    expect(m.note).not.toMatch(/record a payment|Waiting on the customer/i);
    expect(m.canRecordPayment).toBe(false);
    expect(m.openApproval).toBe(true);
  });

  it("accepted but still pending: same owner-approval line instead of 'record the payment when it arrives'", () => {
    const m = quoteMoneyActions(
      { status: "accepted", paymentStatus: "none", invoiceId: null, total: 1180, received: 0, approvalWait: true },
      rupees,
    );
    expect(m.note).toBe(APPROVAL_WAIT_NOTE);
    expect(m.canRecordPayment).toBe(false);
    expect(m.openApproval).toBe(true);
  });

  it("approved → exactly as today", () => {
    expect(approved).toBeNull();
    expect(sentMoney(Boolean(approved))).toEqual(sentMoney(false));
    expect(sentMoney(false).note).toMatch(/^Waiting on the customer/);
    expect(sentMoney(false).canRecordPayment).toBe(true);
    expect(sentMoney(false).openApproval).toBeFalsy();
  });

  it("pending but not below cost → as today (the server takes that money)", () => {
    expect(notBelow).toBeNull();
    expect(sentMoney(Boolean(notBelow)).note).toMatch(/^Waiting on the customer/);
  });

  it("part payment request (R-2054) unchanged", () => {
    const m = sentMoney(true, { partRequest: true });
    expect(m.note).toBe("");
    expect(m.canRecordPayment).toBe(true);
    expect(m.openApproval).toBeFalsy();
  });

  it("an invoiced or closed quote is not touched", () => {
    const inv = sentMoney(true, { invoiceId: "INV-1" });
    expect(inv.stage).toBe("invoiced");
    expect(inv.openApproval).toBeFalsy();
    const closed = sentMoney(true, { status: "rejected" });
    expect(closed.stage).toBe("closed");
    expect(closed.openApproval).toBeFalsy();
  });
});

describe("progress line on a below-cost quote waiting for the owner (R-2334)", () => {
  it("Sent ✓ → Owner approval (current) → Signed (todo)", () => {
    const steps = withApprovalStep(lifecycleSteps().steps, pending, false);
    const stages = steps.map((s) => s.stage);
    expect(stages.slice(0, 4)).toEqual(["draft", "sent", "approval", "signed"]);
    const ap = steps.find((s) => s.stage === "approval")!;
    expect(ap.state).toBe("current");
    expect(ap.label).toBe("Owner approval");
    expect(ap.detail).toMatch(/^Waiting for the owner's approval/);
    expect(steps.find((s) => s.stage === "sent")!.state).toBe("done");
    expect(steps.find((s) => s.stage === "signed")!.state).toBe("todo");
    expect(steps.filter((s) => s.state === "current")).toHaveLength(1);
  });

  it("approved / not below cost → the line is unchanged", () => {
    const before = lifecycleSteps().steps;
    expect(withApprovalStep(before, approved, false)).toEqual(before);
    expect(withApprovalStep(before, notBelow, false)).toEqual(before);
  });

  it("a rejected quote gets no approval step", () => {
    const l = lifecycleSteps("rejected");
    expect(withApprovalStep(l.steps, pending, l.dead)).toEqual(l.steps);
  });

  it("the page wires both: approvalWait from the R-2326 block, and the step into the progress line", () => {
    const src = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(src).toMatch(/approvalWait:\s*Boolean\(payBlock\)/);
    expect(src).toMatch(/withApprovalStep\(/);
    expect(src).toMatch(/money\.openApproval/);
  });
});
