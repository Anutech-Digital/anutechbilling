/**
 * R-1588 — Ads, Google Business, Feedback, Team performance and the Marketing report read
 * EVERY row, not the first 1000.
 *
 * The data gateway answers at most 1000 rows a request (src/server/postgrest/build.ts
 * MAX_ROWS) whatever `.limit()` asked for, and says nothing when it cut the answer short.
 * `.limit(50000)` on ad_spend_daily, `.limit(20000)` on gbp_metrics_daily, `.limit(5000)` on
 * feedback and the unranged month of activity_log all came back as 1000 rows.
 *
 * The fake client below behaves like the gateway (same shape as money-unbounded.test.ts): it
 * honours filters, .order() and .range(), and caps every answer at 1000 rows.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }) }));

import { fetchAdSpend } from "../ads";
import { fetchGbpMetrics } from "../gbp";
import { fetchFeedbackStatuses } from "../feedback";
import { fetchPerformanceInputs } from "../performance";
import { fetchMarketingReport } from "../marketing";
import { helpFacts } from "@/lib/ai/help-facts";

const GATEWAY_MAX_ROWS = 1000;
type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

/** A fake PostgREST that caps like the real gateway. */
function gatewayClient(tables: Record<string, Row[]>) {
  const builder = (source: () => Row[]) => {
    const filters: Filter[] = [];
    const orders: [string, boolean][] = [];
    let limit: number | undefined;
    let offset = 0;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; };
    b.neq = (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return b; };
    b.in = (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; };
    b.gt = (c: string, v: number) => { filters.push((r) => Number(r[c]) > v); return b; };
    b.gte = (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return b; };
    b.lt = (c: string, v: string) => { filters.push((r) => String(r[c]) < v); return b; };
    b.not = (c: string, op: string, v: unknown) => { filters.push((r) => (op === "is" ? (r[c] ?? null) !== v : true)); return b; };
    b.or = () => b;
    b.order = (c: string, o?: { ascending?: boolean }) => { orders.push([c, o?.ascending !== false]); return b; };
    b.limit = (n: number) => { limit = n; return b; };
    b.range = (from: number, to: number) => { offset = from; limit = to - from + 1; return b; };
    const run = () => {
      let rows = source().filter((r) => filters.every((f) => f(r)));
      if (orders.length) {
        rows = [...rows].sort((a, z) => {
          for (const [c, asc] of orders) {
            const x = String(a[c]), y = String(z[c]);
            if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
      }
      const cap = Math.min(limit ?? GATEWAY_MAX_ROWS, GATEWAY_MAX_ROWS);
      return rows.slice(offset, offset + cap);
    };
    b.maybeSingle = () => Promise.resolve({ data: run()[0] ?? null, error: null });
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: run(), error: null }).then(res, rej);
    return b;
  };
  return { from: (table: string) => builder(() => tables[table] ?? []) } as never;
}

const pad = (i: number) => String(i).padStart(5, "0");
const day = (i: number) => new Date(Date.UTC(2026, 3, 1) + (i % 150) * 86_400_000).toISOString().slice(0, 10);

describe("the fake gateway is honest", () => {
  it("the old reads — .limit(50000) / no range — come back as 1000 rows", async () => {
    const c = gatewayClient({ ad_spend_daily: Array.from({ length: 1500 }, (_, i) => ({ day: day(i) })) }) as unknown as {
      from: (t: string) => { select: () => { limit: (n: number) => PromiseLike<{ data: Row[] }> } };
    };
    expect((await c.from("ad_spend_daily").select().limit(50000)).data).toHaveLength(1000);
  });
});

describe("Ads: every spend row (R-1588)", () => {
  it("1,500 spend rows (90 days x 12 campaigns is already 1,080) → all 1,500 and the full spend", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({
      ad_account_id: `acc${i % 2}`, day: day(i), campaign_id: `c${pad(i)}`, campaign_name: `C${i}`,
      spend: 10, impressions: 5, clicks: 1, conversions: 0, conversion_value: 0,
    }));
    const client = gatewayClient({
      ad_accounts: [{ id: "acc0", platform: "google-ads" }, { id: "acc1", platform: "meta-ads" }],
      ad_spend_daily: rows,
    });
    const got = await fetchAdSpend(client, "2026-01-01");
    expect(got).toHaveLength(1500);
    expect(got.reduce((s, r) => s + r.spend, 0)).toBe(15_000);
  });
});

describe("Google Business: every metric row (R-1588)", () => {
  it("1,500 metric rows → 1,500, filtered by listing", async () => {
    const rows = Array.from({ length: 1600 }, (_, i) => ({
      location_id: i < 1500 ? "loc1" : "loc2", day: day(i), metric: `M${pad(i)}`, value: 1,
    }));
    const client = gatewayClient({ gbp_metrics_daily: rows });
    expect(await fetchGbpMetrics(client, "loc1")).toHaveLength(1500);
    expect(await fetchGbpMetrics(client)).toHaveLength(1600);
  });
});

describe("Feedback: tab counts over every report (R-1588)", () => {
  it("1,500 reports → 1,500 statuses", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: `f${pad(i)}`, status: i % 3 ? "open" : "fixed", resolution_note: null }));
    const got = await fetchFeedbackStatuses(gatewayClient({ feedback: rows }));
    expect(got).toHaveLength(1500);
    expect(got.filter((r) => r.status === "fixed")).toHaveLength(500);
  });
});

describe("Team performance: a busy month's activity (R-1588)", () => {
  it("1,500 activity rows for one person → 1,500; renewal payments past the 1000th quote counted", async () => {
    const start = "2026-04-01T00:00:00.000Z", end = "2026-05-01T00:00:00.000Z";
    const activity = Array.from({ length: 1500 }, (_, i) => ({
      id: i + 1, user_id: "u1", created_at: `2026-04-${String(1 + (i % 28)).padStart(2, "0")}T10:00:00.000Z`,
    }));
    const quotes = Array.from({ length: 1300 }, (_, i) => ({ id: `q${pad(i)}`, is_renewal: true, owner_id: "u1", created_at: "2025-01-01T00:00:00.000Z" }));
    const payments = [{ id: "p1", recorded_by: "u1", amount: 500, received_at: "2026-04-10T00:00:00.000Z", status: "received", quote_id: "q01250" }];
    const got = await fetchPerformanceInputs(gatewayClient({ activity_log: activity, quotes, payments }), start, end);
    expect(got.actR.data).toHaveLength(1500);
    expect(got.renewalQuotesR.data.map((q) => q.id)).toEqual(["q01250"]);
    expect(got.kudosR.error).toBeNull();
  });
});

describe("Marketing report: every receipt, lead and expense (R-1588)", () => {
  it("1,500 payments + 1,200 leads + 1,100 marketing expenses → full totals", async () => {
    const payments = Array.from({ length: 1500 }, (_, i) => ({ id: `p${pad(i)}`, amount: 100, received_at: `${day(i)}T10:00:00Z`, status: "received" }));
    const leads = Array.from({ length: 1200 }, (_, i) => ({
      id: `l${pad(i)}`, project_id: null, source: "website", stage: "new", value: 0, created_at: `${day(i)}T10:00:00Z`,
      utm_source: null, utm_medium: null, utm_campaign: null, referrer_url: null,
    }));
    const expenses = Array.from({ length: 1100 }, (_, i) => ({
      id: `e${pad(i)}`, channel: "google-ads", amount: 50, expense_date: day(i), category: "Marketing", vendor_name: "Google",
    }));
    const quotes = Array.from({ length: 1050 }, (_, i) => ({ id: `q${pad(i)}`, created_at: `${day(i)}T10:00:00Z` }));
    const client = gatewayClient({ payments, leads, expenses, quotes, project_payments: [], project_sales: [], ad_accounts: [], ad_spend_daily: [] });
    const got = await fetchMarketingReport(client, { start: "2026-04-01", end: "2027-04-01", label: "FY" });
    expect(got.collected).toBe(150_000);
    expect(got.funnel.find((s) => s.key === "leads")?.count).toBe(1200);
    expect(got.funnel.find((s) => s.key === "quotes")?.count).toBe(1050);
    expect(got.funnel.find((s) => s.key === "won")?.count).toBe(1500);
    expect(got.monthly.reduce((s, m) => s + m.spend, 0)).toBe(55_000);
  });
});

describe("AI help facts: every customer checked for a GST state (R-1588)", () => {
  it("1,500 customers with no state → all counted, still capped at the old 2000", async () => {
    const customers = Array.from({ length: 1500 }, (_, i) => ({ id: `c${pad(i)}`, name: `Cust ${pad(i)}`, state_code: null, country: "IN" }));
    const got = await helpFacts(gatewayClient({ tenants: [], customers }), "t1");
    expect(got.text).toMatch(/Customers: 1500;/);
    expect(got.text).toMatch(/missing a GST state \(invoice cannot be made for them\): 1500/);
  });
});
