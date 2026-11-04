/**
 * R-1884 — Google sunset developer tokens on 9 Sep 2026: API access level now sits on the
 * Google Cloud project, and a `developer-token` header is ignored. The spend sync must work
 * with GOOGLE_ADS_DEVELOPER_TOKEN unset (send the header only when it is set), and an
 * access-level refusal must name the Cloud project, not a missing env var. fetch is mocked —
 * nothing calls Google.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchCampaignSpend, explainGoogleAdsError, listAdAccounts } from "./google-ads-api";

const original = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
afterEach(() => {
  if (original === undefined) delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN; else process.env.GOOGLE_ADS_DEVELOPER_TOKEN = original;
  vi.unstubAllGlobals();
});

function captureHeaders() {
  const seen: Record<string, string>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    seen.push({ ...(init.headers as Record<string, string>) });
    return new Response(JSON.stringify([{ results: [] }]), { status: 200 });
  }));
  return seen;
}

describe("Google Ads developer token is optional (sunset 9 Sep 2026)", () => {
  it("no GOOGLE_ADS_DEVELOPER_TOKEN: the call still goes out, without the header", async () => {
    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    const seen = captureHeaders();
    const rows = await fetchCampaignSpend("fake-access", "123", null, "2026-10-01", "2026-10-02", "ACC");
    expect(rows).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("developer-token");
    expect(seen[0].authorization).toBe("Bearer fake-access");
  });

  it("token still set (older setup): it is passed along", async () => {
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "fake-dev-token";
    const seen = captureHeaders();
    await fetchCampaignSpend("fake-access", "123", "999", "2026-10-01", "2026-10-02", "ACC");
    expect(seen[0]["developer-token"]).toBe("fake-dev-token");
    expect(seen[0]["login-customer-id"]).toBe("999");
  });

  it("an access-level refusal points to the Google Cloud project access level", () => {
    for (const body of [
      "DEVELOPER_TOKEN_NOT_APPROVED",
      "The developer token is only approved for use with test accounts",
      "PERMISSION_DENIED: Google Ads API has not been used in project 123 before or it is disabled",
      '[{"error":{"status":"PERMISSION_DENIED","details":[{"errors":[{"errorCode":{"authorizationError":"CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION"}}]}]}}]',
    ]) {
      const msg = explainGoogleAdsError(403, body);
      expect(msg).toMatch(/Cloud project/i);
      expect(msg).toContain("https://developers.google.com/google-ads/api/docs/api-policy/access-levels");
      expect(msg).not.toMatch(/GOOGLE_ADS_DEVELOPER_TOKEN is not set/);
    }
    expect(explainGoogleAdsError(403, "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION")).toMatch(/Explorer access/i);
  });

  it("skips a disabled account and continues to an active account", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("listAccessibleCustomers")) return Response.json({ resourceNames: ["customers/111", "customers/222"] });
      if (url.includes("customers/111/")) return Response.json([{ error: { code: 403, status: "PERMISSION_DENIED", details: [{ errors: [{ errorCode: { authorizationError: "CUSTOMER_NOT_ENABLED" } }] }] } }], { status: 403 });
      return Response.json([{ results: [{ customer: { id: "222", descriptiveName: "Active Ads", currencyCode: "INR", manager: false } }] }]);
    }));
    await expect(listAdAccounts("fake-access")).resolves.toEqual([
      { id: "222", name: "Active Ads", currency: "INR", manager: false, loginCustomerId: null },
    ]);
  });
});
