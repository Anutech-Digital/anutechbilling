import { describe, it, expect } from "vitest";
import {
  totalsOf, campaignStats, pacing, reconcileMonths, dailySeries, gaqlCampaignSpend,
  googleRowsFromSearchStream, metaRowsFromInsights, adCsvRows, type AdSpendRow,
} from "./ad-platforms";

const G = (day: string, spend: number, over: Partial<AdSpendRow> = {}): AdSpendRow => ({
  platform: "google-ads", account_id: "a1", day, campaign_id: "c1", campaign_name: "Brand", spend, impressions: 1000, clicks: 50, conversions: 2, conversion_value: 0, ...over,
});

describe("ad platforms", () => {
  it("totals with CTR / CPC / CPA", () => {
    const t = totalsOf([G("2026-09-01", 500), G("2026-09-02", 500, { clicks: 30, conversions: 0 })]);
    expect(t.spend).toBe(1000);
    expect(t.ctr).toBe(4);            // 80 / 2000
    expect(t.cpc).toBe(12.5);
    expect(t.cpa).toBe(500);          // 1000 / 2
    expect(totalsOf([]).cpc).toBeNull();
  });

  it("campaign stats: grouped per platform+campaign, leads matched by utm_campaign name", () => {
    const rows = [
      G("2026-09-01", 300), G("2026-09-05", 200),
      G("2026-09-03", 900, { platform: "meta-ads", campaign_id: "m1", campaign_name: "Diwali Offer" }),
    ];
    const s = campaignStats(rows, new Map([["diwali offer", 3], ["brand", 1]]));
    expect(s.map((c) => c.campaign_name)).toEqual(["Diwali Offer", "Brand"]);
    expect(s[0].leads).toBe(3); expect(s[0].cpl).toBe(300);
    expect(s[1].lastActive).toBe("2026-09-05"); expect(s[1].cpl).toBe(500);
  });

  it("pacing projects the month from the daily rate and judges it against the budget", () => {
    const rows = [G("2026-09-01", 1000), G("2026-09-10", 1000), G("2026-08-30", 5000)];
    const p = pacing(rows, "2026-09-10", 5000);
    expect(p.spent).toBe(2000);
    expect(p.daysGone).toBe(10); expect(p.daysInMonth).toBe(30);
    expect(p.projected).toBe(6000);
    expect(p.projectedPct).toBe(120); expect(p.verdict).toBe("over");
    expect(pacing(rows, "2026-09-10", null).verdict).toBe("no_budget");
    expect(pacing(rows, "2026-09-10", 10000).verdict).toBe("under");
  });

  it("reconcile explains the gap between platform and books", () => {
    const rows = [G("2026-08-05", 10000), G("2026-09-05", 8000)];
    const rec = reconcileMonths(rows, new Map([["2026-08", 11800], ["2026-07", 3000]]), "google-ads");
    expect(rec.map((r) => r.month)).toEqual(["2026-09", "2026-08", "2026-07"]);
    expect(rec[1].note).toMatch(/18% GST/);
    expect(rec[0].note).toMatch(/Google Ads.*invoice/);
    expect(rec[2].note).toMatch(/was the account connected/);
    const meta = reconcileMonths([G("2026-09-01", 4000, { platform: "meta-ads" })], new Map(), "meta-ads");
    expect(meta[0].note).toMatch(/advance/);
  });

  it("daily series is dense and split by platform", () => {
    const s = dailySeries([G("2026-09-02", 10), G("2026-09-02", 5, { platform: "meta-ads" })], "2026-09-01", "2026-09-03");
    expect(s).toEqual([
      { day: "2026-09-01", google: 0, meta: 0, linkedin: 0, clicks: 0, conversions: 0 },
      { day: "2026-09-02", google: 10, meta: 5, linkedin: 0, clicks: 100, conversions: 4 },
      { day: "2026-09-03", google: 0, meta: 0, linkedin: 0, clicks: 0, conversions: 0 },
    ]);
  });

  it("parses Google searchStream chunks (micros → rupees)", () => {
    const rows = googleRowsFromSearchStream([{ results: [
      { campaign: { id: 123, name: "Brand" }, segments: { date: "2026-09-01" }, metrics: { costMicros: "1234560000", impressions: "10", clicks: "3", conversions: "1.5", conversionsValue: "0" } },
      { campaign: { id: 123 }, segments: {} },
    ] }], "acc");
    expect(rows).toEqual([{ platform: "google-ads", account_id: "acc", day: "2026-09-01", campaign_id: "123", campaign_name: "Brand", spend: 1234.56, impressions: 10, clicks: 3, conversions: 1.5, conversion_value: 0 }]);
    expect(gaqlCampaignSpend("2026-09-01", "2026-09-30")).toContain("BETWEEN '2026-09-01' AND '2026-09-30'");
  });

  it("parses Meta insights; only lead-type actions count as conversions", () => {
    const rows = metaRowsFromInsights([{
      campaign_id: "m1", campaign_name: "Diwali", date_start: "2026-09-01", spend: "250.5", impressions: "900", clicks: "20",
      actions: [{ action_type: "lead", value: "2" }, { action_type: "link_click", value: "20" }, { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "1" }],
    }, { date_start: "2026-09-01" }], "acc");
    expect(rows).toHaveLength(1);
    expect(rows[0].spend).toBe(250.5); expect(rows[0].conversions).toBe(2);
    expect(adCsvRows(rows, new Map([["acc", "Main Meta account"]]))[0]).toEqual(["2026-09-01", "Facebook / Instagram Ads", "Main Meta account", "Diwali", 250.5, 900, 20, 2, 0]);
  });

  it("R-2520: one lead or one chat is one result, even when Meta lists it under several action types", async () => {
    const { metaResultCount } = await import("./ad-platforms");
    // Meta's "lead" is the total; lead_grouped + pixel lead are parts of it.
    expect(metaResultCount([{ action_type: "lead", value: "5" }, { action_type: "onsite_conversion.lead_grouped", value: "5" }, { action_type: "leadgen_grouped", value: "5" }])).toBe(5);
    // One chat: started + first reply → 1.
    expect(metaResultCount([{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "3" }, { action_type: "onsite_conversion.messaging_first_reply", value: "3" }])).toBe(3);
    // No "lead" total → the grouped number is used once.
    expect(metaResultCount([{ action_type: "onsite_conversion.lead_grouped", value: "4" }, { action_type: "contact", value: "1" }, { action_type: "link_click", value: "40" }])).toBe(4);
    // R-2671: the real Neo Trail SE Asia row (13 Aug–10 Nov): Ads Manager says 105 results, not 108.
    expect(metaResultCount([{ action_type: "lead", value: "105" }, { action_type: "onsite_conversion.lead_grouped", value: "105" }, { action_type: "offsite_complete_registration_add_meta_leads", value: "105" }, { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "3" }, { action_type: "onsite_conversion.messaging_first_reply", value: "3" }])).toBe(105);
    expect(metaResultCount(undefined)).toBe(0);
  });
});

describe("R-2671 open in the platform's ads manager", () => {
  it("builds each platform's link for the account, at the campaign when known", async () => {
    const { adsManagerUrl } = await import("./ad-platforms");
    expect(adsManagerUrl("meta-ads", "act_1322588906661964")).toBe("https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1322588906661964");
    expect(adsManagerUrl("meta-ads", "act_1322588906661964", "120200000001")).toContain("selected_campaign_ids=120200000001");
    expect(adsManagerUrl("google-ads", "144-399-5960")).toBe("https://ads.google.com/aw/campaigns?__e=1443995960");
    expect(adsManagerUrl("linkedin-ads", "512579562")).toBe("https://www.linkedin.com/campaignmanager/accounts/512579562/campaign-groups");
    expect(adsManagerUrl("meta-ads", "../evil")).toBeNull();
  });
});

describe("R-2671 the campaign's goal decides its Result (as in Ads Manager)", () => {
  it("a chat campaign counts chats even with a few stray leads; a lead campaign counts leads", async () => {
    const { metaResultCount, metaResultKind, metaRowsFromInsights } = await import("./ad-platforms");
    // Real 'Google Workspace – India – Sunil': 2,043 chats, 24 stray leads, ad sets optimise for CONVERSATIONS.
    const sunil = [{ action_type: "lead", value: "24" }, { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "2043" }, { action_type: "onsite_conversion.messaging_first_reply", value: "1807" }];
    expect(metaResultKind(["CONVERSATIONS"])).toBe("chats");
    expect(metaResultCount(sunil, "chats")).toBe(2043);
    expect(metaResultCount(sunil, "leads")).toBe(24);
    expect(metaResultKind(["LEAD_GENERATION", "CONVERSATIONS"])).toBe("leads+chats");
    expect(metaResultKind(["LINK_CLICKS"])).toBeUndefined();
    const rows = metaRowsFromInsights([{ campaign_id: "c1", date_start: "2026-10-01", actions: sunil }], "acc", new Map([["c1", "chats" as const]]));
    expect(rows[0].conversions).toBe(2043);
  });
});

describe("R-2671 Google keeps ₹0-cost days that still have impressions or conversions", () => {
  it("does not ask Google to drop ₹0-cost days, and skips only fully empty days", async () => {
    const { gaqlCampaignSpend, googleRowsFromSearchStream } = await import("./ad-platforms");
    expect(gaqlCampaignSpend("2026-09-01", "2026-09-30")).not.toContain("cost_micros > 0");
    const rows = googleRowsFromSearchStream([{ results: [
      { campaign: { id: "1", name: "cloud-search" }, segments: { date: "2026-09-02" }, metrics: { costMicros: "0", impressions: "11", clicks: "0", conversions: 0 } },
      { campaign: { id: "1", name: "cloud-search" }, segments: { date: "2026-09-03" }, metrics: { costMicros: "0", impressions: "0", clicks: "0", conversions: 2 } },
      { campaign: { id: "1", name: "cloud-search" }, segments: { date: "2026-09-04" }, metrics: { costMicros: "0", impressions: "0", clicks: "0", conversions: 0 } },
    ] }], "acc");
    expect(rows.map((r) => [r.day, r.impressions, r.conversions])).toEqual([["2026-09-02", 11, 0], ["2026-09-03", 0, 2]]);
  });
});
