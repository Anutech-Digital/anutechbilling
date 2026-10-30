/**
 * R-2155 — the quote accept page's Pay button (POST /api/public/quote/[id]/pay → startQuotePayment)
 * on staging with a LIVE Razorpay key: refused in words, no Razorpay order, nothing recorded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  quote: null as Record<string, unknown> | null,
  secrets: {} as Record<string, unknown> | null,
  rpc: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: table === "quotes" ? db.quote : db.secrets, error: null }),
        then: (ok: (v: unknown) => unknown) => ok({ data: [], error: null }),
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
const call = () =>
  POST(new NextRequest(`https://example.invalid/api/public/quote/Q-T-0001/pay?t=${TOKEN}`, { method: "POST" }), {
    params: Promise.resolve({ id: "Q-T-0001" }),
  });

beforeEach(() => {
  db.quote = {
    id: "Q-T-0001", status: "sent", payment_status: "pending", expires_date: "2099-01-01",
    amount: 708, currency: "INR", customer_name: "Asha Co", tenant_id: "t-1", public_token: TOKEN,
    invoice_id: null, billing_cycle: "yearly", subtotal: 600, discount_pct: 0, tax_rate: 18,
    created_date: "2026-09-28", line_items: [{ commitment: "annual_yearly" }],
  };
  db.secrets = { razorpay_key_id: "rzp_live_k", razorpay_key_secret: "s", razorpay_mode: "live" };
  db.rpc.mockReset().mockResolvedValue({ error: null });
  rzp.create.mockReset().mockResolvedValue({ id: "order_T1" });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("R-2155 quote pay on staging", () => {
  it("live key + staging → 403 with the staging message, no order, nothing recorded", async () => {
    vi.stubEnv("APP_ENV", "staging");
    const res = await call();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Staging cannot take real payments/);
    expect(body.stagingLiveKey).toBe(true);
    expect(rzp.create).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("the staging host alone is enough of a signal", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://resellersos-staging-xyz.a.run.app");
    expect((await call()).status).toBe(403);
    expect(rzp.create).not.toHaveBeenCalled();
  });

  it("live key on the live deployment still creates the order", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://billing.example.invalid");
    const res = await call();
    expect(res.status).toBe(200);
    expect(rzp.create).toHaveBeenCalledTimes(1);
  });
});
