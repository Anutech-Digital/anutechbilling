import { describe, it, expect } from "vitest";
import { apiNeedsMfaCode } from "./mfa-gate";

describe("apiNeedsMfaCode (R-701)", () => {
  it.each([
    "/api/team/invite",
    "/api/vault/x/reveal",
    "/api/auth/onboarding/new-tenant",
    "/api/auth/signup/extra",
    "/api/publicity",
    "/api/versionx",
    "/api/webhooksx/razorpay",
  ])("%s waits for the code", (p) => expect(apiNeedsMfaCode(p)).toBe(true));

  it.each([
    "/api/public/catalog/workspace",
    "/api/webhooks/razorpay",
    "/api/cron/renewals",
    "/api/health/money",
    "/api/version",
    "/api/version/",
    "/api/monitoring/sentry-dsn",
    "/api/auth/signup",
    "/api/auth/verify-email",
    "/api/auth/resend-verification",
  ])("%s stays open", (p) => expect(apiNeedsMfaCode(p)).toBe(false));

  it("ignores pages (the /mfa redirect handles those)", () => {
    expect(apiNeedsMfaCode("/leads")).toBe(false);
    expect(apiNeedsMfaCode("/apix")).toBe(false);
  });
});
