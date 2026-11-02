import { afterEach, expect, it, vi } from "vitest";
import { fetchLinkedInCampaignSpend, listLinkedInAdAccounts } from "./linkedin-ads-api";

afterEach(() => vi.unstubAllGlobals());

it("requests campaign groups and keeps older monthly spend", async () => {
  const requested: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requested.push(url);
    return new Response(JSON.stringify(url.includes("adCampaignGroups")
      ? { elements: [{ id: 42, name: "Workspace leads" }] }
      : { elements: [{ pivotValues: ["urn:li:sponsoredCampaignGroup:42"], dateRange: { start: { year: 2023, month: 12, day: 1 } }, costInLocalCurrency: "125.50", impressions: 100, clicks: 4, externalWebsiteConversions: 1 }] }), { status: 200 });
  }));

  const rows = await fetchLinkedInCampaignSpend("test-token", "123", "2023-12-01", "2023-12-31", "internal-id", "MONTHLY");
  expect(requested.find((url) => url.includes("adAnalytics"))).toContain("pivots=List(CAMPAIGN_GROUP)");
  expect(requested.find((url) => url.includes("adAnalytics"))).toContain("timeGranularity=MONTHLY&fields=dateRange,pivotValues");
  expect(rows).toMatchObject([{ day: "2023-12-01", campaign_id: "group:42", campaign_name: "Workspace leads", spend: 125.5, clicks: 4 }]);
});

it("discovers multiple LinkedIn accounts across pages", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
    url.includes("pageToken=next")
      ? { elements: [{ id: 2, name: "Second account", currency: "USD", status: "ACTIVE" }], metadata: {} }
      : { elements: [{ id: 1, name: "First account", currency: "INR", status: "ACTIVE" }], metadata: { nextPageToken: "next" } },
  ), { status: 200 })));
  expect((await listLinkedInAdAccounts("test-token")).map((a) => a.name)).toEqual(["First account", "Second account"]);
});
