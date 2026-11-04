/**
 * R-2165 — one fact, one place: the "Sales by campaign" report (campaign-sales.ts, R-1980)
 * gives, on the SAME seed as supabase/tests/r2165_marketing_metrics_query.test.sql, the
 * numbers that test asserts for public.marketing_metrics_query. If either side changes a
 * rule, one of the two tests goes red.
 */
import { describe, expect, it } from "vitest";
import { campaignSalesReport, NO_CAMPAIGN, type CampaignSalesInput } from "@/lib/marketing/campaign-sales";

const seed: CampaignSalesInput = {
  range: { start: "2026-10-01", end: "2026-10-08" },
  campaigns: [
    { id: "c1", code: "gw-delhi", name: "Workspace Delhi" },
    { id: "c2", code: "m365", name: "M365 Promo" },
  ],
  leads: [
    { id: "L1", created_at: "2026-10-02T06:00:00+00:00", source: null, referrer_url: null, utm_campaign: "GW-Delhi", utm_content: "ad-a" },
    { id: "L2", created_at: "2026-10-03T06:00:00+00:00", source: null, referrer_url: null, utm_campaign: "m365", utm_content: "ad-b" },
    { id: "L3", created_at: "2026-10-05T06:00:00+00:00", source: null, referrer_url: null, utm_campaign: null },
  ],
  quotes: [
    { id: "Q1", lead_id: "L1", invoice_id: "INV1", tax_rate: 18 },
    { id: "Q2", lead_id: "L2", invoice_id: null, tax_rate: 18 },
    { id: "Q3", lead_id: null, invoice_id: null, tax_rate: 18 },
  ],
  invoices: [{ id: "INV1", quote_id: "Q1", amount: 11800, taxable_value: 10000 }],
  billings: [],
  subscriptions: [],
  payments: [
    { id: "P1", quote_id: "Q1", invoice_id: null, amount: 11800, status: "received", received_at: "2026-10-03T06:00:00+00:00", refunded_at: null },
    { id: "P2", quote_id: "Q2", invoice_id: null, amount: 5900, status: "refunded", received_at: "2026-10-04T06:00:00+00:00", refunded_at: "2026-10-06T06:00:00+00:00" },
    { id: "P3", quote_id: "Q3", invoice_id: null, amount: 2360, status: "received", received_at: "2026-10-05T06:00:00+00:00", refunded_at: null },
  ],
  spendDays: [
    { platform: "meta-ads", day: "2026-10-02", campaign_id: "111", campaign_name: "gw-delhi", spend: 1000, clicks: 100, impressions: 10000 },
    { platform: "google-ads", day: "2026-10-03", campaign_id: "g-22", campaign_name: "M365 Promo", spend: 500, clicks: 50, impressions: 5000 },
  ],
  campaignExpenses: [
    { campaign_id: "c1", amount: 1180, channel: "meta-ads" },
    { campaign_id: "c2", amount: 200, channel: "design" },
  ],
};

describe("Sales by campaign = marketing_metrics_query on the shared seed", () => {
  const r = campaignSalesReport(seed);
  const row = (k: string) => r.rows.find((x) => x.key === k)!;

  it("totals: spend 1700, revenue 12000, ROAS 5.88, paid orders 2, ads CAC 1700, leads 3 (SQL test A)", () => {
    expect(r.totals.spend).toBe(1700);
    expect(r.totals.revenue).toBe(12000);
    expect(r.totals.roas).toBe(5.88);
    expect(r.totals.paidOrders).toBe(2);
    expect(r.adTotals.cac).toBe(1700);
    expect(r.totals.leads).toBe(3);
    expect(r.totals.clicks).toBe(150);
  });

  it("per campaign (SQL test B1–B3)", () => {
    expect(row("gw-delhi")).toMatchObject({ name: "Workspace Delhi", spend: 1000, revenue: 10000, roas: 10, leads: 1 });
    expect(row("m365")).toMatchObject({ spend: 700, revenue: 0, roas: 0, leads: 1 });
    expect(row(NO_CAMPAIGN)).toMatchObject({ name: "Not from an ad campaign", revenue: 2000, roas: null, leads: 1 });
  });
});
