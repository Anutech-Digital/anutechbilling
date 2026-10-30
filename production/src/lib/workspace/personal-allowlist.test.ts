/** GP-07b (R-2116): which /api paths a personal session may call. */
import { describe, it, expect } from "vitest";
import { isPersonalApiAllowed, PERSONAL_API_PREFIXES } from "./personal-allowlist";

describe("isPersonalApiAllowed (GP-07b)", () => {
  it("names the personal workspace's own API", () => {
    expect(PERSONAL_API_PREFIXES).toEqual(["/api/vault/personal", "/api/personal", "/api/dms/sso", "/api/support-sso"]);
  });

  it.each([
    "/api/vault/personal", "/api/vault/personal/pin", "/api/personal/x", "/api/dms/sso", "/api/support-sso",
    "/api/auth/mfa/aal", "/api/public/checkout", "/api/webhooks/razorpay", "/api/version", "/api/version/",
    "/api/health/money", "/api/domains/availability", "/api/sb/rest/v1/personal_accounts", "/api/monitoring/sentry-dsn",
  ])("allows %s", (p) => expect(isPersonalApiAllowed(p)).toBe(true));

  it.each([
    "/api/invoices", "/api/vault", "/api/vault/personalx", "/api/vault/abc", "/api/personalize", "/api/dms/ssox",
    "/api/dms/panel-order", "/api/ai/help", "/api/ai/extract-statement", "/api/versionx", "/api/publicity",
    "/api/webhooksx/razorpay", "/api/cron/renewals", "/api/team/invite", "/api/domains", "/api/sbx",
  ])("refuses %s", (p) => expect(isPersonalApiAllowed(p)).toBe(false));
});
