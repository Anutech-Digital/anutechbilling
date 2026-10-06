import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isStorefrontTenant, ownerPaymentAlertAllowed, storefrontSupportEmail, storefrontVoice } from "./storefront-voice";

const STORE = "22222222-2222-2222-2222-222222222222";
const RESELLER = "7e57e57e-0000-4000-8000-000000000001";
const local = { NODE_ENV: "development", BUY_PAGE_TENANT_ID: STORE };

describe("storefrontVoice — the shop signs as the company, replies go to support", () => {
  it("the storefront tenant: '— Anutech Digital', reply to support", () => {
    expect(storefrontVoice(STORE, local)).toEqual({ signOff: "— Anutech Digital", replyTo: "support@anutech.in" });
  });
  it("SUPPORT_EMAIL overrides the support desk", () => {
    expect(storefrontVoice(STORE, { ...local, SUPPORT_EMAIL: " help@example.in " })?.replyTo).toBe("help@example.in");
    expect(storefrontSupportEmail({})).toBe("support@anutech.in");
  });
  it("a reseller tenant keeps its own voice", () => {
    expect(storefrontVoice(RESELLER, local)).toBeNull();
    expect(isStorefrontTenant(RESELLER, local)).toBe(false);
  });
  it("no tenant id, or no storefront configured on a deployed server → nobody is the storefront", () => {
    expect(storefrontVoice(null, local)).toBeNull();
    expect(storefrontVoice("", local)).toBeNull();
    expect(isStorefrontTenant(STORE, { NODE_ENV: "production" })).toBe(false);
  });
  it("off a deployed server the dev storefront tenant is used when none is set", () => {
    expect(isStorefrontTenant("fbb976f1-9090-4f10-9726-0901bd144e42", { NODE_ENV: "development" })).toBe(true);
  });
});

describe("ownerPaymentAlertAllowed — off on a developer machine only", () => {
  it("off only with NO_OWNER_PAYMENT_ALERT_LOCAL=1 on a laptop", () => {
    expect(ownerPaymentAlertAllowed({ NODE_ENV: "development", NO_OWNER_PAYMENT_ALERT_LOCAL: "1" })).toBe(false);
    expect(ownerPaymentAlertAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(ownerPaymentAlertAllowed({ NODE_ENV: "development", NO_OWNER_PAYMENT_ALERT_LOCAL: "0" })).toBe(true);
  });
  it("a deployed server always sends it, whatever the flag says", () => {
    expect(ownerPaymentAlertAllowed({ NODE_ENV: "production", NO_OWNER_PAYMENT_ALERT_LOCAL: "1" })).toBe(true);
    expect(ownerPaymentAlertAllowed({ NODE_ENV: "development", K_SERVICE: "reselleros", NO_OWNER_PAYMENT_ALERT_LOCAL: "1" })).toBe(true);
    expect(ownerPaymentAlertAllowed({ NODE_ENV: "development", NEXT_PUBLIC_APP_ENV: "staging", NO_OWNER_PAYMENT_ALERT_LOCAL: "1" })).toBe(true);
  });
});

describe("wired into the storefront's customer emails", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it.each([
    "src/app/api/webhooks/razorpay/route.ts",
    "src/lib/hosting/start-trial.ts",
    "src/app/api/public/trial/workspace/route.ts",
    "src/app/api/public/checkout/workspace/route.ts",
    "src/app/api/public/enquiry/general/route.ts",
    "src/app/api/public/enquiry/workspace/route.ts",
    "src/app/api/cron/trial-expiry/route.ts",
  ])("%s signs and replies with storefrontVoice()", (file) => {
    const src = read(file);
    expect(src).toContain("storefrontVoice(");
    expect(src).toMatch(/voice \? voice\.signOff/);
  });
  it("the payment-received owner alerts honour the local switch", () => {
    expect(read("src/app/api/webhooks/razorpay/route.ts")).toMatch(/owner\.ok && ownerPaymentAlertAllowed\(\) && sendEmail\(\{\s*to:\s*owner\.to/);
    expect(read("src/app/api/public/checkout/workspace/route.ts")).toMatch(/owner\.ok && ownerPaymentAlertAllowed\(\) && sendEmail\(\{\s*to:\s*owner\.to/);
  });
  it("the paid-order customer email no longer waits on the owner address", () => {
    expect(read("src/app/api/webhooks/razorpay/route.ts")).toContain("customerEmail && customerReplyTo && sendEmail({");
  });
});
