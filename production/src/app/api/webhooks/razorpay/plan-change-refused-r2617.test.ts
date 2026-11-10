/**
 * R-2617 — record_payment's "plan change refused — a seat cut … is scheduled" (trigger
 * subscriptions_r2617_plan_change_vs_seat_cut) is a plan-change refusal like R-2227/R-2589: the
 * Razorpay webhook answers 200 and tells the owner (settleRefusedPlanChange), never a retry loop.
 */
import { describe, expect, it, vi } from "vitest";

const notified = vi.hoisted(() => [] as { body: string }[]);
vi.mock("@/lib/notifications/notify.server", () => ({
  notifyTenantOwners: async (n: { body: string }) => { notified.push(n); },
}));

import { PLAN_CHANGE_REFUSED_RE, settleRefusedPlanChange, type LateArgs } from "./late-payment.server";

describe("R-2617 PLAN_CHANGE_REFUSED_RE", () => {
  it.each([
    "R-2617: plan change refused — a seat cut 10 → 7 is scheduled for the end of this term (01 Apr 2027). Remove the scheduled seat cut in Manage seats first, then change the plan.",
    "R-2589: plan/seats changed since this quote Q-1 was made",
    "R-2227: plan change quote Q-1 is no longer linked to its subscription",
  ])("matches %s", (msg) => {
    expect(PLAN_CHANGE_REFUSED_RE.test(msg)).toBe(true);
  });

  it("other R-2617-like errors do not", () => {
    expect(PLAN_CHANGE_REFUSED_RE.test("R-2617x: plan change refused")).toBe(false);
    expect(PLAN_CHANGE_REFUSED_RE.test("R-2073: plan dropped from the catalogue")).toBe(false);
  });
});

describe("R-2617 settleRefusedPlanChange — next step for a scheduled seat cut", () => {
  const admin = {
    from: () => {
      const q = { select: () => q, eq: () => q, limit: async () => ({ data: [], error: null }) };
      return q;
    },
  } as never;
  const args = {
    quote: { id: "Q-PC-1", tenant_id: "t-1", lead_id: null },
    payment: { id: "pay_R2617", amount: 1_180_000 },
    event: "payment.captured", orderId: "order_1", recordFee: async () => undefined,
  } as unknown as LateArgs;

  it("keeps the quote: remove the cut, then record this payment on it — never \"delete the old quote\"", async () => {
    notified.length = 0;
    const res = await settleRefusedPlanChange(admin, args,
      "R-2617: plan change refused — a seat cut 10 → 7 is scheduled for the end of this term (1 Apr 2027). Remove the scheduled seat cut in Manage seats first, then change the plan.");
    expect(res.status).toBe(200);
    const body = notified[0]?.body ?? "";
    expect(body).toContain("refused because a seat cut is scheduled (plan change refused — a seat cut 10 → 7");
    expect(body).toContain("remove the scheduled seat cut in Manage seats, then record this payment on quote Q-PC-1 (Record payment, reference pay_R2617)");
    expect(body).not.toMatch(/delete the old quote/i);
  });

  it("an R-2589 refusal keeps the generic step (delete + new quote)", async () => {
    notified.length = 0;
    await settleRefusedPlanChange(admin, args, "R-2589: plan/seats changed since this quote Q-PC-1 was made. Nothing was recorded.");
    expect(notified[0]?.body ?? "").toMatch(/First delete the old quote Q-PC-1/);
  });
});
