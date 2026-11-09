/**
 * R-2626 — record_payment's "plan change refused — Q3 (…) is already invoiced / already has proforma …"
 * (trigger subscriptions_r2626_plan_change_vs_later_part) is a plan-change refusal like R-2617: the
 * Razorpay webhook answers 200 and tells the owner (settleRefusedPlanChange) the right next step.
 */
import { describe, expect, it, vi } from "vitest";

const notified = vi.hoisted(() => [] as { body: string }[]);
vi.mock("@/lib/notifications/notify.server", () => ({
  notifyTenantOwners: async (n: { body: string }) => { notified.push(n); },
}));

import { PLAN_CHANGE_REFUSED_RE, settleRefusedPlanChange, type LateArgs } from "./late-payment.server";

const INVOICED = "R-2626: plan change refused — Q3 (1 Oct 2026 – 31 Dec 2026) is already invoiced (INV-ANUT-27-0042) at the current plan's rate. Change the plan once that part starts, or on the renewal quote.";
const PROFORMA = "R-2626: plan change refused — Q3 (1 Oct 2026 – 31 Dec 2026) already has proforma PI-ANUT-27-0007 at the current plan's rate. Cancel that proforma first (open it → Cancel proforma), then change the plan; the part is billed again at the new rate on its date.";

describe("R-2626 PLAN_CHANGE_REFUSED_RE", () => {
  it.each([INVOICED, PROFORMA])("matches %s", (msg) => {
    expect(PLAN_CHANGE_REFUSED_RE.test(msg)).toBe(true);
  });
  it("R-26260 / other text does not", () => {
    expect(PLAN_CHANGE_REFUSED_RE.test("R-26260: plan change refused")).toBe(false);
  });
});

describe("R-2626 settleRefusedPlanChange — next step for a later part already billed", () => {
  const admin = {
    from: () => {
      const q = { select: () => q, eq: () => q, limit: async () => ({ data: [], error: null }) };
      return q;
    },
  } as never;
  const args = {
    quote: { id: "Q-PC-1", tenant_id: "t-1", lead_id: null },
    payment: { id: "pay_R2626", amount: 1_180_000 },
    event: "payment.captured", orderId: "order_1", recordFee: async () => undefined,
  } as unknown as LateArgs;

  it("open proforma: cancel it, then record THIS payment on the same quote", async () => {
    notified.length = 0;
    const res = await settleRefusedPlanChange(admin, args, PROFORMA);
    expect(res.status).toBe(200);
    const body = notified[0]?.body ?? "";
    expect(body).toContain("refused because a later billing part is already billed at the old rate (plan change refused — Q3 (1 Oct 2026 – 31 Dec 2026) already has proforma PI-ANUT-27-0007");
    expect(body).toContain("open that proforma and Cancel proforma, then record this payment on quote Q-PC-1 (Record payment, reference pay_R2626)");
  });

  it("invoiced part: this quote can't be paid — delete it, refund or keep as advance", async () => {
    notified.length = 0;
    await settleRefusedPlanChange(admin, args, INVOICED);
    const body = notified[0]?.body ?? "";
    expect(body).toContain("already invoiced (INV-ANUT-27-0042)");
    expect(body).toMatch(/This quote cannot be paid while that part is invoiced\. Delete quote Q-PC-1, then refund the customer/);
    expect(body).not.toMatch(/record this payment on quote Q-PC-1/);
  });
});
