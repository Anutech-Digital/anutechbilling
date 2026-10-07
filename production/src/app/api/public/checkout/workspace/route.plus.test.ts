/**
 * R-328: the public Workspace checkout refuses Business Plus (price on request, never sold
 * online) BEFORE it reads the catalogue, asks for a state or touches Razorpay. Starter is
 * not refused by this rule.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const createAdminClient = vi.hoisted(() => vi.fn(() => ({ from: () => { throw new Error("db read"); } })));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient }));
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: () => null }));
vi.mock("@/lib/marketing/utm", () => ({ captureFromRequest: () => ({}) }));

import { POST } from "./route";

const req = (tierId: string) =>
  new NextRequest("https://example.invalid/api/public/checkout/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fullName: "Test Buyer", companyName: "Test Co", email: "buyer@example.invalid", phone: "9999999999",
      seats: 5, domain: "example.in", tierId, stateCode: "07", simulate: true,
    }),
  });

beforeEach(() => createAdminClient.mockClear());

describe("public checkout — Business Plus (R-328)", () => {
  it("refuses Plus with a clear 'get a quote' message and charges nothing", async () => {
    const res = await POST(req("plus"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; priceOnRequest?: boolean };
    expect(body.error).toMatch(/Business Plus/);
    expect(body.error).toMatch(/Nothing was charged/);
    expect(body.error).toMatch(/Get a quote/);
    expect(body.priceOnRequest).toBe(true);
    expect(body.error).not.toMatch(/1,?380|₹/);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("Starter is not refused by the Plus rule (it goes on to the database)", async () => {
    const res = await POST(req("starter"));
    const body = (await res.json().catch(() => ({}))) as { priceOnRequest?: boolean };
    expect(body.priceOnRequest).toBeUndefined();
    expect(createAdminClient).toHaveBeenCalled();
  });
});
