/**
 * R-1980 — Sales by campaign: payments actually received (ex GST, refunds taken off), traced
 * payment → quote → lead (or the quote's own ad columns once R-1978 adds them), next to the
 * campaign's spend, clicks and leads.
 *
 * The fixture below is the SAME data as the local scenario `ads-month`
 * (scripts/dev/scenarios/ads-month.sql) — the numbers asserted here were worked out by hand:
 *
 *   SCN Workspace Oct (utm_campaign scn-ws-oct, Meta)
 *     spend   Meta ad account 3,000 + 2,000 = 5,000, plus a designer bill tagged to the
 *             campaign 1,000 (the Meta invoice also tagged to it is the SAME money as the
 *             platform's spend — not added again) = 6,000
 *     clicks  150 + 100 = 250 · impressions 6,000 + 4,000 = 10,000
 *     leads   L1, L2, L3 = 3
 *     money   L1 annual 11,800 incl GST → 10,000
 *             L2 5,900 → 5,000 received, then refunded in the month → −5,000
 *             L3 monthly flex: invoice with NO quote (subscription billing) 1,180 → 1,000
 *             = 11,000 net (16,000 received − 5,000 refunded)
 *     paid orders L1, L3 = 2 (L2 refunded in full)
 *     ROAS 11,000 / 6,000 = 1.83 · CAC 6,000 / 2 = 3,000
 *   SCN Google Search (utm_campaign scn-gads-search; Google names it "SCN Google Search")
 *     spend 4,000 · clicks 80 · impressions 2,000 · leads L4, L6 = 2
 *     money L4 23,600 paid in two halves → 20,000 · paid orders 1
 *     ROAS 5.00 · CAC 4,000
 *   Not from a campaign: L5 2,360 → 2,000 · 1 order · 1 lead
 *   Total: spend 10,000 · revenue 33,000 · paid orders 4
 */
import { describe, it, expect } from "vitest";
import {
  campaignSalesReport, paymentExGst, resolvePaymentOrder, adSourceText, NO_CAMPAIGN,
  type CampaignSalesInput,
} from "./campaign-sales";

const D = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;
const T = (n: number) => `${D(n)}T06:00:00.000Z`;
const RANGE = { start: "2026-10-01", end: "2026-11-01" };

function fixture(): CampaignSalesInput {
  return {
    range: RANGE,
    campaigns: [
      { id: "mc1", code: "scn-ws-oct", name: "SCN Workspace Oct" },
      { id: "mc2", code: "scn-gads-search", name: "SCN Google Search" },
    ],
    leads: [
      { id: "L1", created_at: T(2), source: "buy-workspace-direct", utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "scn-ws-oct", referrer_url: null },
      { id: "L2", created_at: T(3), source: "buy-workspace-direct", utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "scn-ws-oct", referrer_url: null },
      { id: "L3", created_at: T(4), source: "buy-workspace-direct", utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "SCN-WS-OCT ", referrer_url: null },
      { id: "L4", created_at: T(5), source: "buy-workspace-direct", utm_source: "google", utm_medium: "cpc", utm_campaign: "scn-gads-search", referrer_url: null },
      { id: "L5", created_at: T(6), source: "buy-workspace-direct", utm_source: null, utm_medium: null, utm_campaign: null, referrer_url: null },
      { id: "L6", created_at: T(7), source: "buy-workspace", utm_source: "google", utm_medium: "cpc", utm_campaign: "scn-gads-search", referrer_url: null },
    ],
    quotes: [
      { id: "Q1", lead_id: "L1", invoice_id: "INV1", tax_rate: 18 },
      { id: "Q2", lead_id: "L2", invoice_id: null, tax_rate: 18 },
      { id: "Q3", lead_id: "L3", invoice_id: null, tax_rate: 18 },
      { id: "Q4", lead_id: "L4", invoice_id: null, tax_rate: 18 },
      { id: "Q5", lead_id: "L5", invoice_id: null, tax_rate: 18 },
    ],
    invoices: [
      { id: "INV1", quote_id: "Q1", amount: 11800, taxable_value: 10000 },
      // monthly flex: subscription billing raised it, quote_id NULL
      { id: "INV3", quote_id: null, amount: 1180, taxable_value: 1000 },
    ],
    billings: [{ invoice_id: "INV3", subscription_id: "S3" }],
    subscriptions: [{ id: "S3", quote_id: "Q3" }],
    payments: [
      { id: "P1", quote_id: "Q1", invoice_id: "INV1", amount: 11800, status: "received", received_at: T(8), refunded_at: null },
      { id: "P2", quote_id: "Q2", invoice_id: null, amount: 5900, status: "refunded", received_at: T(9), refunded_at: T(12) },
      { id: "P3", quote_id: null, invoice_id: "INV3", amount: 1180, status: "received", received_at: T(10), refunded_at: null },
      { id: "P4a", quote_id: "Q4", invoice_id: null, amount: 11800, status: "received", received_at: T(11), refunded_at: null },
      { id: "P4b", quote_id: "Q4", invoice_id: null, amount: 11800, status: "received", received_at: T(13), refunded_at: null },
      { id: "P5", quote_id: "Q5", invoice_id: null, amount: 2360, status: "received", received_at: T(14), refunded_at: null },
      // outside the range — never counted
      { id: "P0", quote_id: "Q1", invoice_id: null, amount: 99999, status: "received", received_at: "2026-09-30T06:00:00.000Z", refunded_at: null },
    ],
    spendDays: [
      { platform: "meta-ads", day: D(2), campaign_id: "SCN-META-1", campaign_name: "scn-ws-oct", spend: 3000, clicks: 150, impressions: 6000 },
      { platform: "meta-ads", day: D(3), campaign_id: "SCN-META-1", campaign_name: "scn-ws-oct", spend: 2000, clicks: 100, impressions: 4000 },
      { platform: "google-ads", day: D(3), campaign_id: "SCN-G-2", campaign_name: "SCN Google Search", spend: 4000, clicks: 80, impressions: 2000 },
    ],
    campaignExpenses: [
      { campaign_id: "mc1", amount: 1000, channel: null },        // designer — real extra cost
      { campaign_id: "mc1", amount: 4000, channel: "meta-ads" },  // Meta invoice = the platform spend again
    ],
  };
}

describe("R-1980 campaignSalesReport — the ads-month scenario, worked by hand", () => {
  const r = campaignSalesReport(fixture());
  const row = (key: string) => r.rows.find((x) => x.key === key)!;

  it("Workspace Oct: spend 6,000, 250 clicks, 3 leads, 2 paid orders, 11,000 net, ROAS 1.83, CAC 3,000", () => {
    const c = row("scn-ws-oct");
    expect(c.name).toBe("SCN Workspace Oct");
    expect(c.channel).toBe("meta-ads");
    expect(c.spend).toBe(6000);
    expect(c.clicks).toBe(250);
    expect(c.impressions).toBe(10000);
    expect(c.leads).toBe(3);
    expect(c.paidOrders).toBe(2);
    expect(c.received).toBe(16000);
    expect(c.refunded).toBe(5000);
    expect(c.revenue).toBe(11000);
    expect(c.roas).toBeCloseTo(1.83, 2);
    expect(c.cac).toBe(3000);
  });

  it("Google Search: matched by the platform's campaign NAME, 20,000 from two instalments = 1 order", () => {
    const c = row("scn-gads-search");
    expect(c.spend).toBe(4000);
    expect(c.clicks).toBe(80);
    expect(c.leads).toBe(2);
    expect(c.paidOrders).toBe(1);
    expect(c.revenue).toBe(20000);
    expect(c.roas).toBe(5);
    expect(c.cac).toBe(4000);
  });

  it("an order with no campaign is its own row, with no spend, ROAS or CAC", () => {
    const c = row(NO_CAMPAIGN);
    expect(c.revenue).toBe(2000);
    expect(c.paidOrders).toBe(1);
    expect(c.leads).toBe(1);
    expect(c.spend).toBe(0);
    expect(c.roas).toBeNull();
    expect(c.cac).toBeNull();
  });

  it("totals: spend 10,000, revenue 33,000, 4 paid orders; campaigns first, biggest revenue first", () => {
    expect(r.totals.spend).toBe(10000);
    expect(r.totals.revenue).toBe(33000);
    expect(r.totals.paidOrders).toBe(4);
    expect(r.rows.map((x) => x.key)).toEqual(["scn-gads-search", "scn-ws-oct", NO_CAMPAIGN]);
    expect(r.unmatchedSpend).toBe(0);
  });

  it("platform spend that matches no campaign code is reported, never dropped", () => {
    const f = fixture();
    f.spendDays.push({ platform: "google-ads", day: D(4), campaign_id: "X9", campaign_name: "Brand old", spend: 700, clicks: 5, impressions: 50 });
    const rr = campaignSalesReport(f);
    const c = rr.rows.find((x) => x.key === "brand old")!;
    expect(c.spend).toBe(700);
    expect(c.revenue).toBe(0);
    expect(c.roas).toBe(0);
    expect(rr.totals.spend).toBe(10700);
  });

  it("a campaign with no platform rows takes its booked (tagged) expenses as spend — the ad invoice included", () => {
    const f = fixture();
    f.spendDays = f.spendDays.filter((s) => s.platform !== "meta-ads");
    expect(campaignSalesReport(f).rows.find((x) => x.key === "scn-ws-oct")!.spend).toBe(5000);
  });
});

describe("R-1980 attribution: payment → quote → lead (or the quote's own ad columns)", () => {
  const f = fixture();
  const idx = {
    quotes: new Map(f.quotes.map((q) => [q.id, q])),
    invoices: new Map(f.invoices.map((i) => [i.id, i])),
    billings: new Map(f.billings.map((b) => [b.invoice_id, b])),
    subscriptions: new Map(f.subscriptions.map((s) => [s.id, s])),
    leads: new Map(f.leads.map((l) => [l.id, l])),
  };

  it("a monthly flex invoice (quote_id NULL) reaches its lead through subscription → quote", () => {
    const o = resolvePaymentOrder(f.payments[2], idx);
    expect(o.quote?.id).toBe("Q3");
    expect(o.attribution.campaign).toBe("SCN-WS-OCT ");
    expect(o.orderKey).toBe("lead:L3");
  });

  it("an invoice's own quote_id is used when the payment has only the invoice", () => {
    const o = resolvePaymentOrder({ ...f.payments[0], quote_id: null }, idx);
    expect(o.quote?.id).toBe("Q1");
  });

  it("the quote's own ad set (R-1978) wins as a whole over the lead's — no mixing of two visits", () => {
    const quotes = new Map(idx.quotes);
    quotes.set("Q1", { ...quotes.get("Q1")!, utm_source: "instagram", utm_campaign: "ig-retarget", utm_term: "adset-2", utm_content: "ad-7" });
    const o = resolvePaymentOrder(f.payments[0], { ...idx, quotes });
    expect(o.attribution).toMatchObject({ source: "instagram", campaign: "ig-retarget", term: "adset-2", content: "ad-7", medium: null });
  });

  it("ex GST: invoice taxable share first, else the quote's GST rate", () => {
    expect(paymentExGst(11800, { amount: 11800, taxable_value: 10000 }, { tax_rate: 18 })).toBe(10000);
    expect(paymentExGst(5900, null, { tax_rate: 18 })).toBe(5000);
    expect(paymentExGst(1000, null, { tax_rate: 0 })).toBe(1000);
    expect(paymentExGst(1180, null, null)).toBe(1000);
  });
});

describe("R-1980 ad set / ad rows (utm_term / utm_content, once quotes carry them)", () => {
  it("splits a campaign into ad set → ad children; spend stays on the campaign", () => {
    const f = fixture();
    f.quotes = f.quotes.map((q) => (q.id === "Q1" ? { ...q, utm_term: "adset-a", utm_content: "ad-1" } : q));
    const c = campaignSalesReport(f).rows.find((x) => x.key === "scn-ws-oct")!;
    expect(c.children.map((k) => [k.adSet, k.ad, k.revenue, k.paidOrders])).toEqual([
      ["adset-a", "ad-1", 10000, 1],
      [null, null, 1000, 1],
    ]);
  });

  it("no children when no order carries an ad set or ad", () => {
    expect(campaignSalesReport(fixture()).rows.every((r) => r.children.length === 0)).toBe(true);
  });
});

describe("R-1980 adSourceText — the Online Orders 'Source' cell", () => {
  it("names the campaign and the channel", () => {
    expect(adSourceText({ utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "scn-ws-oct", referrer_url: null }, new Map([["scn-ws-oct", "SCN Workspace Oct"]])))
      .toEqual({ channel: "meta-ads", campaign: "SCN Workspace Oct" });
    expect(adSourceText({ utm_source: "google", utm_medium: "cpc", utm_campaign: "x-1", referrer_url: null }, new Map()))
      .toEqual({ channel: "google-ads", campaign: "x-1" });
  });
  it("no ad data → null (the cell shows a dash)", () => {
    expect(adSourceText({ utm_source: null, utm_medium: null, utm_campaign: null, referrer_url: null }, new Map())).toBeNull();
  });
});
