/**
 * R-1980 (localhost check, 26 Oct 2026) — the funnel said "Ad clicks — not measured" while the
 * Sales-by-campaign table beside it showed 330 clicks from the connected ad accounts. Clicks
 * ARE measured once an ad account syncs: the funnel's first step reads ad_spend_daily.clicks.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { fetchMarketingReport } from "./marketing";

type Row = Record<string, unknown>;
function client(tables: Record<string, Row[]>) {
  const builder = (rowsOf: () => Row[]) => {
    const filters: ((r: Row) => boolean)[] = [];
    let from = 0, to = 999;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; };
    b.neq = (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return b; };
    b.in = (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; };
    b.gte = (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return b; };
    b.lt = (c: string, v: string) => { filters.push((r) => String(r[c]) < v); return b; };
    b.not = () => b;
    b.or = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.range = (a: number, z: number) => { from = a; to = z; return b; };
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: rowsOf().filter((r) => filters.every((f) => f(r))).slice(from, to + 1), error: null }).then(res, rej);
    return b;
  };
  return { from: (t: string) => builder(() => tables[t] ?? []) } as never;
}

const base = { payments: [], leads: [], expenses: [], quotes: [], project_payments: [], project_sales: [] };
const RANGE = { start: "2026-10-01", end: "2026-11-01", label: "This month" };

describe("R-1980: funnel Ad clicks from the ad accounts", () => {
  it("330 clicks synced (150 + 100 Meta, 80 Google) → the clicks step is measured, 330", async () => {
    const got = await fetchMarketingReport(client({
      ...base,
      ad_accounts: [{ id: "A1", platform: "meta-ads" }, { id: "A2", platform: "google-ads" }],
      ad_spend_daily: [
        { ad_account_id: "A1", day: "2026-10-02", campaign_id: "M1", spend: 3000, clicks: 150 },
        { ad_account_id: "A1", day: "2026-10-03", campaign_id: "M1", spend: 2000, clicks: 100 },
        { ad_account_id: "A2", day: "2026-10-03", campaign_id: "G2", spend: 4000, clicks: 80 },
      ],
    }), RANGE);
    const clicks = got.funnel.find((s) => s.key === "clicks")!;
    expect(clicks.available).toBe(true);
    expect(clicks.count).toBe(330);
  });

  it("no ad account synced → still 'not measured', never a zero", async () => {
    const got = await fetchMarketingReport(client({ ...base, ad_accounts: [], ad_spend_daily: [] }), RANGE);
    const clicks = got.funnel.find((s) => s.key === "clicks")!;
    expect(clicks.available).toBe(false);
    expect(clicks.count).toBeNull();
  });
});
