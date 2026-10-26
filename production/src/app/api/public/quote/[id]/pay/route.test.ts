/**
 * POST /api/public/quote/[id]/pay — pinned 28 Sep 2026, before its order-creation was
 * shared with the DMS panel's renewal payment (lib/checkout/quote-order.ts). Nothing here
 * had a test until then (L58), so these fix what the customer-facing pay button does today.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  quote: null as Record<string, unknown> | null,
  secrets: {} as Record<string, unknown> | null,
  /* R-1569: the payments already on the quote — the order charges what is still due. */
  payments: [] as Record<string, unknown>[],
  rpc: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
        maybeSingle: async () => ({ data: table === "quotes" ? db.quote : db.secrets, error: null }),
        then: (ok: (v: unknown) => unknown) =>
          ok({ data: table === "payments" ? db.payments.filter((r) => filters.every(([c, v]) => r[c] === v)) : [], error: null }),
      };
      return chain;
    },
    rpc: db.rpc,
  }),
}));
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: (s: unknown) => s }));
const rzp = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("razorpay", () => ({ default: class { orders = { create: rzp.create }; } }));

import { POST } from "./route";

const TOKEN = "11111111-2222-4333-8444-555555555555";
const baseQuote = () => ({
  id: "Q-T-0001", status: "sent", payment_status: "pending", expires_date: "2099-01-01",
  amount: 708, currency: "INR", customer_name: "Asha Co", tenant_id: "t-1", public_token: TOKEN,
  invoice_id: null, billing_cycle: "yearly", subtotal: 600, discount_pct: 0, tax_rate: 18,
  created_date: "2026-09-28", line_items: [{ commitment: "annual_yearly" }],
});
const call = (t: string | null = TOKEN) =>
  POST(new NextRequest(`https://example.invalid/api/public/quote/Q-T-0001/pay${t ? `?t=${t}` : ""}`, { method: "POST" }), {
    params: Promise.resolve({ id: "Q-T-0001" }),
  });

const ENV = { ...process.env };
beforeEach(() => {
  db.quote = baseQuote();
  db.secrets = { razorpay_key_id: "rzp_test_k", razorpay_key_secret: "s", razorpay_mode: "test" };
  db.payments = [];
  db.rpc.mockReset().mockResolvedValue({ error: null });
  rzp.create.mockReset().mockResolvedValue({ id: "order_T1" });
});
afterEach(() => { process.env = { ...ENV }; });

describe("who may pay", () => {
  it("a wrong or missing token looks like a missing quote", async () => {
    expect((await call("nope")).status).toBe(404);
    expect((await call(null)).status).toBe(404);
    expect(rzp.create).not.toHaveBeenCalled();
  });
});

describe("state guards", () => {
  it.each([
    [{ status: "draft" }, 400],
    [{ status: "rejected" }, 400],
    [{ payment_status: "received" }, 409],
    [{ invoice_id: "INV-1" }, 409],
    [{ expires_date: "2020-01-01" }, 400],
    [{ amount: 600 }, 409], // total disagrees with its own 18% GST
    [{ currency: "USD" }, 400],
  ])("%o → %i, no order", async (patch, status) => {
    db.quote = { ...baseQuote(), ...patch };
    expect((await call()).status).toBe(status);
    expect(rzp.create).not.toHaveBeenCalled();
  });
});

describe("the order", () => {
  it("is the quote total in paise, receipt = quote id, notes say kind quote", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, orderId: "order_T1", amount: 70800, razorpayKeyId: "rzp_test_k", razorpayMode: "test", quoteId: "Q-T-0001" });
    expect(rzp.create.mock.calls[0][0]).toMatchObject({
      amount: 70800, currency: "INR", receipt: "Q-T-0001",
      notes: { kind: "quote", quoteId: "Q-T-0001", tenantId: "t-1", customerName: "Asha Co" },
    });
  });
  it("a coupon quote (₹600 − 10% + 18% = ₹637) can be paid — R-082", async () => {
    db.quote = { ...baseQuote(), discount_pct: 10, amount: 637 };
    const res = await call();
    expect(res.status).toBe(200);
    expect(rzp.create.mock.calls[0][0]).toMatchObject({ amount: 63700 });
  });
  it("a coupon quote missing its GST is still refused", async () => {
    db.quote = { ...baseQuote(), discount_pct: 10, amount: 540 };
    expect((await call()).status).toBe(409);
    expect(rzp.create).not.toHaveBeenCalled();
  });
  it("a Razorpay failure is a retryable message, not a raw error", async () => {
    rzp.create.mockRejectedValue(new Error("boom"));
    const res = await call();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Could not start payment. Please retry.");
  });
  it("without Razorpay keys, outside production, it simulates through record_payment", async () => {
    db.secrets = null;
    delete process.env.RAZORPAY_KEY_ID; delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET;
    const res = await call();
    const body = await res.json();
    // The env keys are read at import; when this machine has them, the live path runs instead.
    if (body.simulated) {
      expect(db.rpc).toHaveBeenCalledWith("record_payment", expect.objectContaining({ p_quote_id: "Q-T-0001", p_amount: 708, p_reference: "SIM-QUOTEPAY-Q-T-0001" }));
    } else {
      expect(body.orderId).toBe("order_T1");
    }
  });
});

/* R-1569 (audit 18 Oct): quote-order.ts:150 charged `quote.amount` on a PART-PAID quote — ₹20,000
   of ₹50,000 already in, the link took ₹50,000 again and the extra became credit. The order is
   now the amount still DUE: quote total − payments received (a TDS settlement is part of the
   payment's amount, so it counts). Refunded payments are not money in hand. */
describe("R-1569 — a part-paid quote charges only what is still due", () => {
  const paid = (amount: number, status = "received") =>
    ({ tenant_id: "t-1", quote_id: "Q-T-0001", amount, status });

  it("₹708 quote with ₹400 already received → the order is ₹308", async () => {
    db.quote = { ...baseQuote(), status: "accepted", payment_status: "partial" };
    db.payments = [paid(400)];
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ amount: 30800, amountRupees: 308, quoteTotal: 708, alreadyPaid: 400 });
    expect(rzp.create.mock.calls[0][0]).toMatchObject({ amount: 30800, notes: { quoteTotal: "708", alreadyPaid: "400" } });
  });

  it("a refunded payment is not counted as paid", async () => {
    db.quote = { ...baseQuote(), status: "accepted", payment_status: "partial" };
    db.payments = [paid(400, "refunded"), paid(100)];
    const res = await call();
    expect(res.status).toBe(200);
    expect(rzp.create.mock.calls[0][0]).toMatchObject({ amount: 60800 });
  });

  it("nothing left to pay (payments cover the total) → 409 with a next step, no order", async () => {
    db.quote = { ...baseQuote(), status: "accepted", payment_status: "partial" };
    db.payments = [paid(500), paid(208)];
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already paid in full/i);
    expect(body.nextStep).toMatch(/receipt/i);
    expect(rzp.create).not.toHaveBeenCalled();
  });

  it("a quote replaced by another (superseded_by) is refused and names the new quote", async () => {
    db.quote = { ...baseQuote(), status: "accepted", superseded_by: "Q-T-0009" };
    const res = await call();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Q-T-0009");
    expect(rzp.create).not.toHaveBeenCalled();
  });
});

/* R-1923 (G-ONBOARD OB-2): the RAZORPAY_KEY_* env pair is the platform's (Anutech's) own
   account. A company without its own keys used to fall back to it — its customer paid Anutech.
   The env keys are now for the platform tenant (BUY_PAGE_TENANT_ID, lib/website-tenant.ts) only. */
describe("R-1923 — the platform's Razorpay is never used for another company", () => {
  const setEnvKeys = (platformTenant: string) => {
    process.env.BUY_PAGE_TENANT_ID = platformTenant;
    process.env.RAZORPAY_KEY_ID = "rzp_test_platform";
    process.env.RAZORPAY_KEY_SECRET = "platform-secret";
  };

  it("a company without its own keys, env keys set, on a deployment → 503, no order, nothing recorded", async () => {
    setEnvKeys("platform-tenant");
    process.env.K_SERVICE = "billing"; // a deployed server: simulation is off (R-079)
    db.secrets = null;
    const res = await call();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.notConfigured).toBe(true);
    expect(body.error).toMatch(/online payment isn't available/i);
    expect(rzp.create).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("the platform tenant without stored keys still pays through the env keys", async () => {
    setEnvKeys("t-1");
    db.secrets = null;
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ orderId: "order_T1", razorpayKeyId: "rzp_test_platform", razorpayMode: "test" });
    expect(rzp.create).toHaveBeenCalledTimes(1);
  });

  it("a company with its own keys uses its own keys, not the env ones", async () => {
    setEnvKeys("platform-tenant");
    db.secrets = { razorpay_key_id: "rzp_test_own", razorpay_key_secret: "own", razorpay_mode: "test" };
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).razorpayKeyId).toBe("rzp_test_own");
  });
});
