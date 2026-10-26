// @vitest-environment jsdom
/* R-1984 — "Sales by campaign": the footer row is the ADS total (campaign rows only) with ads ROAS
   3.10× on ads-month; the "Not from an ad campaign" row sits below it with no ROAS. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { campaignSalesReport, type CampaignSalesReport } from "@/lib/marketing/campaign-sales";

const h = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { tenantId: "t1" } }) }));
vi.mock("@/lib/queries/marketing-sales", () => ({ useCampaignSales: () => ({ data: h.data, isLoading: false, error: null }) }));

import { CampaignSalesTable } from "./campaign-sales-table";

afterEach(cleanup);

const T = (d: number) => `2026-10-${String(d).padStart(2, "0")}T06:00:00.000Z`;
/** ads-month in short: Meta 5,000 spend / 250 clicks, Google 4,000 / 80 (+1,000 designer on Meta),
    ads money 11,000 + 20,000 (ex GST), and 3,50,000 paid with no campaign. */
function report(): CampaignSalesReport {
  return campaignSalesReport({
    range: { start: "2026-10-01", end: "2026-11-01" },
    campaigns: [
      { id: "c1", code: "scn-ws-oct", name: "SCN Workspace Oct" },
      { id: "c2", code: "scn-gads-search", name: "SCN Google Search" },
    ],
    leads: [
      { id: "L1", created_at: T(2), source: null, referrer_url: null, utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "scn-ws-oct" },
      { id: "L4", created_at: T(5), source: null, referrer_url: null, utm_source: "google", utm_medium: "cpc", utm_campaign: "scn-gads-search" },
      { id: "L5", created_at: T(6), source: null, referrer_url: null },
    ],
    quotes: [
      { id: "Q1", lead_id: "L1", invoice_id: null, tax_rate: 18 },
      { id: "Q4", lead_id: "L4", invoice_id: null, tax_rate: 18 },
      { id: "Q5", lead_id: "L5", invoice_id: null, tax_rate: 18 },
    ],
    invoices: [], billings: [], subscriptions: [],
    payments: [
      { id: "P1", quote_id: "Q1", invoice_id: null, amount: 12980, status: "received", received_at: T(3), refunded_at: null },
      { id: "P4", quote_id: "Q4", invoice_id: null, amount: 23600, status: "received", received_at: T(6), refunded_at: null },
      { id: "P5", quote_id: "Q5", invoice_id: null, amount: 413000, status: "received", received_at: T(7), refunded_at: null },
    ],
    spendDays: [
      { platform: "meta-ads", day: "2026-10-02", campaign_id: "M1", campaign_name: "scn-ws-oct", spend: 5000, clicks: 250, impressions: 10000 },
      { platform: "google-ads", day: "2026-10-03", campaign_id: "G2", campaign_name: "SCN Google Search", spend: 4000, clicks: 80, impressions: 2000 },
    ],
    campaignExpenses: [{ campaign_id: "c1", amount: 1000, channel: null }],
  });
}

describe("R-1984 Sales by campaign — Ads total", () => {
  it("footer reads 'Ads total' with ads-only ROAS 3.10× (not 38×), 330 clicks", () => {
    h.data = report();
    render(<CampaignSalesTable range="this_month" />);
    const total = screen.getByText("Ads total").closest("tr")!;
    expect(within(total).getByText("3.10×")).toBeTruthy();
    expect(within(total).getByText("330")).toBeTruthy();
    expect(screen.queryByText("Total")).toBeNull();
    expect(screen.queryByText(/38\.\d\d×|39\.\d\d×/)).toBeNull();
  });

  it("'Not from an ad campaign' comes AFTER the Ads total, with no ROAS", () => {
    h.data = report();
    render(<CampaignSalesTable range="this_month" />);
    const rows = screen.getAllByRole("row");
    const iTotal = rows.findIndex((r) => r.textContent?.includes("Ads total"));
    const iNone = rows.findIndex((r) => r.textContent?.includes("Not from an ad campaign"));
    expect(iTotal).toBeGreaterThan(0);
    expect(iNone).toBeGreaterThan(iTotal);
    expect(rows[iNone].textContent).not.toMatch(/×/);
  });
});
