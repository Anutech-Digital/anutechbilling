/**
 * R-1769 — the Workspace buy page had the same "keys present → live only" rule as the cart
 * checkout. .env.local carries an rzp_test_ key pair, so a laptop server that reads it hid
 * Simulate payment and the route refused a simulated order ("Simulation is disabled in live
 * mode"). A laptop with TEST keys now simulates; a deployment or a LIVE key still refuses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const reached = vi.hoisted(() => ({ catalog: false }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "tenant_secrets") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      }
      reached.catalog = true; // past every payment-mode gate
      throw new Error("stop: catalogue read");
    },
    rpc: vi.fn(),
  }),
}));
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: () => null }));
vi.mock("@/lib/marketing/utm", () => ({ captureFromRequest: () => ({}) }));

const ENV = { ...process.env };
const req = () =>
  new NextRequest("https://example.invalid/api/public/checkout/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fullName: "Test Buyer", companyName: "Test Co", email: "buyer@example.invalid", phone: "9999999999",
      seats: 5, domain: "example.in", tierId: "starter", stateCode: "07", simulate: true,
    }),
  });

/** The route reads the env keys when it loads, so each case loads it fresh. */
async function post(env: Record<string, string>) {
  Object.assign(process.env, env);
  vi.resetModules();
  const { POST } = await import("./route");
  return POST(req());
}

beforeEach(() => { reached.catalog = false; });
afterEach(() => { process.env = { ...ENV }; });

describe("R-1769: Workspace checkout with Razorpay TEST keys", { timeout: 60_000 }, () => {
  it("on a laptop a simulated order goes past the payment gates", async () => {
    const res = await post({ RAZORPAY_KEY_ID: "rzp_test_r1769", RAZORPAY_KEY_SECRET: "test-secret" });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    expect(body.error ?? "").not.toMatch(/disabled in live mode|isn't available/);
    expect(reached.catalog).toBe(true);
  });

  it("on a deployment (Cloud Run) a simulated order is refused before anything is read", async () => {
    const res = await post({ RAZORPAY_KEY_ID: "rzp_test_r1769", RAZORPAY_KEY_SECRET: "test-secret", K_SERVICE: "anutech-staging" });
    expect(res.status).toBe(503);
    expect(reached.catalog).toBe(false);
  });

  it("with a LIVE key on a laptop a simulated order is refused", async () => {
    const res = await post({ RAZORPAY_KEY_ID: "rzp_live_r1769", RAZORPAY_KEY_SECRET: "live-secret" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(reached.catalog).toBe(false);
  });
});

describe("R-1769: the Workspace page picks its mode with the shared helper", () => {
  it("uses checkoutPaymentMode with the key id, not its own keys→live rule", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("src/app/(public)/buy/workspace/page.tsx", "utf8");
    expect(page).toMatch(/checkoutPaymentMode\(\{/);
    expect(page).toMatch(/simulatedPaymentAllowed\(\{ razorpayKeyId: keyId \}\)/);
  });
});
