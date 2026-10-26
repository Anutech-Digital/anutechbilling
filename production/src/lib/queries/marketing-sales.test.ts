/**
 * R-1980 — the Sales-by-campaign reads, against an in-memory PostgREST stand-in.
 *
 * Proves the three things the query layer owns:
 *   1. today (no R-1978 columns) the ad fields come from the LEAD, and a monthly flex payment
 *      (invoice from subscription billing, quote_id NULL) still reaches its lead;
 *   2. the day quotes carry their own utm_* columns, they are read and win — no code change;
 *   3. a payment refunded in the range is read even though it was received earlier.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => { throw new Error("not in tests"); } }));

import { adColumns, fetchCampaignSales, QUOTE_AD_COLUMNS } from "./marketing-sales";
import { NO_CAMPAIGN } from "@/lib/marketing/campaign-sales";

type Row = Record<string, unknown>;

/** A tiny PostgREST: select (unknown column → 42703), eq, gte, lt, in, not-is-null, order, range, limit. */
function fakeDb(tables: Record<string, Row[]>, columns: Record<string, string[]>) {
  return {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let cols: string[] = [];
      let lim: number | null = null;
      let from = 0, to = Number.MAX_SAFE_INTEGER;
      const b = {
        select(s: string) { cols = s.split(",").map((c) => c.trim()); return b; },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
        gte(c: string, v: string) { filters.push((r) => r[c] != null && String(r[c]) >= v); return b; },
        lt(c: string, v: string) { filters.push((r) => r[c] != null && String(r[c]) < v); return b; },
        in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return b; },
        not(c: string, _op: string, _v: null) { filters.push((r) => r[c] != null); return b; },
        order() { return b; },
        range(a: number, z: number) { from = a; to = z; return b; },
        limit(n: number) { lim = n; return b; },
        then(res: (v: { data: Row[] | null; error: unknown }) => unknown) {
          const known = columns[table] ?? [];
          const bad = cols.find((c) => !known.includes(c));
          if (bad) return Promise.resolve({ data: null, error: { code: "42703", message: `column ${table}.${bad} does not exist` } }).then(res);
          let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          rows = rows.slice(from, to + 1);
          if (lim !== null) rows = rows.slice(0, lim);
          return Promise.resolve({ data: rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))), error: null }).then(res);
        },
      };
      return b;
    },
  };
}

const TEN = "t-1";
const RANGE = { start: "2026-10-01", end: "2026-11-01", label: "This month" };

function world(withQuoteAdColumns: boolean) {
  const base = {
    payments: ["id", "tenant_id", "quote_id", "invoice_id", "amount", "status", "received_at", "refunded_at"],
    invoices: ["id", "tenant_id", "quote_id", "amount", "taxable_value"],
    subscription_billings: ["id", "tenant_id", "invoice_id", "subscription_id"],
    subscriptions: ["id", "tenant_id", "quote_id"],
    quotes: ["id", "tenant_id", "lead_id", "invoice_id", "tax_rate", ...(withQuoteAdColumns ? QUOTE_AD_COLUMNS : [])],
    leads: ["id", "tenant_id", "created_at", "source", "utm_source", "utm_medium", "utm_campaign", "referrer_url"],
    ad_accounts: ["id", "tenant_id", "platform"],
    ad_spend_daily: ["tenant_id", "ad_account_id", "day", "campaign_id", "campaign_name", "spend", "clicks", "impressions"],
    marketing_campaigns: ["id", "tenant_id", "code", "name"],
    expenses: ["id", "tenant_id", "campaign_id", "amount", "channel", "expense_date"],
  };
  const tables: Record<string, Row[]> = {
    payments: [
      { id: "P1", tenant_id: TEN, quote_id: "Q1", invoice_id: null, amount: 11800, status: "received", received_at: "2026-10-08T06:00:00Z", refunded_at: null },
      { id: "P3", tenant_id: TEN, quote_id: null, invoice_id: "INV3", amount: 1180, status: "received", received_at: "2026-10-10T06:00:00Z", refunded_at: null },
      // received in September, refunded in October → −5,000 in October only
      { id: "P9", tenant_id: TEN, quote_id: "Q1", invoice_id: null, amount: 5900, status: "refunded", received_at: "2026-09-20T06:00:00Z", refunded_at: "2026-10-12T06:00:00Z" },
      { id: "PX", tenant_id: "t-other", quote_id: "QX", invoice_id: null, amount: 99999, status: "received", received_at: "2026-10-08T06:00:00Z", refunded_at: null },
    ],
    invoices: [{ id: "INV3", tenant_id: TEN, quote_id: null, amount: 1180, taxable_value: 1000 }],
    subscription_billings: [{ id: "SB3", tenant_id: TEN, invoice_id: "INV3", subscription_id: "S3" }],
    subscriptions: [{ id: "S3", tenant_id: TEN, quote_id: "Q3" }],
    quotes: [
      { id: "Q1", tenant_id: TEN, lead_id: "L1", invoice_id: null, tax_rate: 18,
        ...(withQuoteAdColumns ? { utm_source: "instagram", utm_medium: "paid_social", utm_campaign: "ig-oct", utm_term: "set-a", utm_content: "ad-1" } : {}) },
      { id: "Q3", tenant_id: TEN, lead_id: "L3", invoice_id: null, tax_rate: 18 },
      { id: "QX", tenant_id: "t-other", lead_id: "LX", invoice_id: null, tax_rate: 18 },
    ],
    leads: [
      // L1 was created last month — still read, because a paid quote points to it
      { id: "L1", tenant_id: TEN, created_at: "2026-09-02T06:00:00Z", source: "buy-workspace-direct", utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "ws-oct", referrer_url: null },
      { id: "L3", tenant_id: TEN, created_at: "2026-10-03T06:00:00Z", source: "buy-workspace-direct", utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "ws-oct", referrer_url: null },
    ],
    ad_accounts: [{ id: "A1", tenant_id: TEN, platform: "meta-ads" }],
    ad_spend_daily: [{ tenant_id: TEN, ad_account_id: "A1", day: "2026-10-02", campaign_id: "M1", campaign_name: "ws-oct", spend: "3000.00", clicks: 90, impressions: 4000 }],
    marketing_campaigns: [{ id: "mc1", tenant_id: TEN, code: "ws-oct", name: "Workspace Oct" }],
    expenses: [],
  };
  return fakeDb(tables, base);
}

describe("R-1980 adColumns — the one switch for R-1978's quote columns", () => {
  it("none before R-1978, all five after", async () => {
    expect((await adColumns(world(false) as never)).quote).toEqual([]);
    expect((await adColumns(world(true) as never)).quote).toEqual([...QUOTE_AD_COLUMNS]);
  });
});

describe("R-1980 fetchCampaignSales", () => {
  it("today: lead's campaign; flex invoice reaches its lead; refund of a September payment comes off October", async () => {
    const r = await fetchCampaignSales(world(false) as never, RANGE, TEN);
    const ws = r.rows.find((x) => x.key === "ws-oct")!;
    // P1 10,000 + P3 1,000 − P9 refund 5,000
    expect(ws.received).toBe(11000);
    expect(ws.refunded).toBe(5000);
    expect(ws.revenue).toBe(6000);
    expect(ws.paidOrders).toBe(2);
    expect(ws.spend).toBe(3000);
    expect(ws.clicks).toBe(90);
    expect(ws.leads).toBe(1); // only L3 was created in October
    expect(ws.name).toBe("Workspace Oct");
    expect(r.rows.find((x) => x.key === NO_CAMPAIGN)).toBeUndefined();
    // the other company's ₹99,999 never shows
    expect(r.totals.received).toBe(11000);
  });

  it("after R-1978: the quote's own campaign + ad set + ad are used, no code change", async () => {
    const r = await fetchCampaignSales(world(true) as never, RANGE, TEN);
    const ig = r.rows.find((x) => x.key === "ig-oct")!;
    expect(ig.revenue).toBe(5000); // P1 10,000 − refund 5,000 (both on Q1)
    expect(ig.children[0]).toMatchObject({ adSet: "set-a", ad: "ad-1" });
    expect(r.rows.find((x) => x.key === "ws-oct")!.revenue).toBe(1000); // the flex one stays on the lead's campaign
  });
});
