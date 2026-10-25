/**
 * R-1923 (G-ONBOARD OB-2): the RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET env pair is the
 * PLATFORM's (Anutech's) own Razorpay account. A quote of any other company must never be
 * charged through it — that company's customer would pay Anutech.
 */
import { describe, it, expect } from "vitest";
import { platformEnvRazorpayKeys, quotePayOnlineOffered } from "./platform-razorpay";

const PLATFORM = "11111111-aaaa-4aaa-8aaa-111111111111";
const OTHER = "22222222-bbbb-4bbb-8bbb-222222222222";
const env = (extra: Record<string, string> = {}) => ({
  NODE_ENV: "test",
  BUY_PAGE_TENANT_ID: PLATFORM,
  RAZORPAY_KEY_ID: "rzp_test_platform",
  RAZORPAY_KEY_SECRET: "platform-secret",
  ...extra,
});

describe("platformEnvRazorpayKeys — the env keys belong to the platform tenant only", () => {
  it("the platform tenant gets the env keys", () => {
    expect(platformEnvRazorpayKeys(PLATFORM, env())).toEqual({
      keyId: "rzp_test_platform", keySecret: "platform-secret", mode: "test",
    });
  });
  it("a live env key is reported as live", () => {
    expect(platformEnvRazorpayKeys(PLATFORM, env({ RAZORPAY_KEY_ID: "rzp_live_x" }))?.mode).toBe("live");
  });
  it("another company never gets the env keys, even when they are set", () => {
    expect(platformEnvRazorpayKeys(OTHER, env())).toBeNull();
  });
  it("NEXT_PUBLIC_RAZORPAY_KEY_ID counts as the env key id for the platform only", () => {
    const e = { ...env(), RAZORPAY_KEY_ID: "", NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_test_pub" };
    expect(platformEnvRazorpayKeys(PLATFORM, e)?.keyId).toBe("rzp_test_pub");
    expect(platformEnvRazorpayKeys(OTHER, e)).toBeNull();
  });
  it("no platform tenant configured on a laptop → nobody gets the env keys", () => {
    expect(platformEnvRazorpayKeys(PLATFORM, { ...env(), BUY_PAGE_TENANT_ID: "" })).toBeNull();
  });
  it("production without BUY_PAGE_TENANT_ID → only the live Anutech tenant (website-tenant.ts)", () => {
    const e = { ...env(), NODE_ENV: "production", BUY_PAGE_TENANT_ID: "" };
    expect(platformEnvRazorpayKeys("fbb976f1-9090-4f10-9726-0901bd144e42", e)).not.toBeNull();
    expect(platformEnvRazorpayKeys(OTHER, e)).toBeNull();
  });
  it("env keys half-set → null", () => {
    expect(platformEnvRazorpayKeys(PLATFORM, { ...env(), RAZORPAY_KEY_SECRET: "" })).toBeNull();
  });
});

describe("quotePayOnlineOffered — the accept page's Pay online button", () => {
  it("a company without its own keys: no Pay online, even with env keys set", () => {
    expect(quotePayOnlineOffered({ tenantId: OTHER, tenantHasOwnKeys: false, currency: "INR" }, env())).toBe(false);
  });
  it("a company with its own keys: Pay online", () => {
    expect(quotePayOnlineOffered({ tenantId: OTHER, tenantHasOwnKeys: true, currency: "INR" }, env())).toBe(true);
  });
  it("the platform tenant without stored keys still gets Pay online from env", () => {
    expect(quotePayOnlineOffered({ tenantId: PLATFORM, tenantHasOwnKeys: false, currency: "INR" }, env())).toBe(true);
  });
  it("a foreign-currency quote never gets Pay online", () => {
    expect(quotePayOnlineOffered({ tenantId: OTHER, tenantHasOwnKeys: true, currency: "USD" }, env())).toBe(false);
  });
  it("a quote with no currency is ₹", () => {
    expect(quotePayOnlineOffered({ tenantId: OTHER, tenantHasOwnKeys: true, currency: null }, env())).toBe(true);
  });
});
