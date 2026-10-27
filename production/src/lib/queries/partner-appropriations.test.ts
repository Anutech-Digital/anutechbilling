/**
 * R-1849 — what the profit-split screen sends to post_partner_appropriation, how posted rows
 * come back, and that statutory dues (TDS payable) include the partners' TDS.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }) }));

import { toPostedSplits, postPayload } from "./partner-appropriations";
import { fetchStatutoryDues } from "./payroll";
import { partnerAppropriation } from "@/lib/accounting/partner-appropriation";

type Row = Record<string, unknown>;
function fakeClient(tables: Record<string, Row[]>, missing: string[] = []) {
  const builder = (name: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let offset = 0; let limit = 1000;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; };
    b.neq = (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return b; };
    b.in = (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; };
    b.gt = (c: string, v: number) => { filters.push((r) => Number(r[c]) > v); return b; };
    b.gte = (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return b; };
    b.lte = (c: string, v: string) => { filters.push((r) => String(r[c]) <= v); return b; };
    b.order = () => b;
    b.range = (from: number, to: number) => { offset = from; limit = to - from + 1; return b; };
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      if (missing.includes(name)) return Promise.resolve({ data: null, error: { message: `relation "public.${name}" does not exist` } }).then(res, rej);
      const rows = (tables[name] ?? []).filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: rows.slice(offset, offset + limit), error: null }).then(res, rej);
    };
    return b;
  };
  return { from: (t: string) => builder(t) } as never;
}

describe("postPayload — the lines the database checks", () => {
  it("doneWhen numbers go out as whole rupees, remuneration 0 for a non-working partner", () => {
    const a = partnerAppropriation({
      fyStart: 2025, netProfit: 1_060_000, today: "2026-10-25",
      partners: [
        { id: "a", name: "Asha", sharePct: 60, capitalBase: 500_000, joinedOn: null, leftOn: null, pan: "ABCDE1234F" },
        { id: "b", name: "Bimal", sharePct: 40, capitalBase: 0, joinedOn: null, leftOn: null, pan: "ABCDE1234G" },
      ],
      terms: { a: { interestPct: 12, remuneration: 500_000, working: true }, b: { interestPct: 12, remuneration: 400_000, working: true } },
    });
    const p = postPayload(a);
    expect(p.p_fy_start).toBe(2025);
    expect(p.p_net_profit).toBe(1_060_000);
    expect(p.p_lines[0]).toMatchObject({ partner_id: "a", capital_base: 500_000, interest_days: 365, interest_pct: 12, interest: 60_000, remuneration: 433_333, profit_share: 132_000, tds: 49_333 });
    expect(p.p_lines[1]).toMatchObject({ partner_id: "b", deed_remuneration: 400_000, remuneration: 346_667, tds: 34_667 });
  });
});

describe("toPostedSplits", () => {
  it("numbers from strings, oldest year first", () => {
    const rows = [
      { id: "h2", fy_start: 2025, posted_on: "2026-03-31", net_profit: "100", interest_total: 0, book_profit: 100, max_remuneration: 300000, remuneration_total: 0, residual: 100, tds_total: 0, created_at: "x",
        partner_appropriation_lines: [{ partner_id: "a", share_pct: "60.00", capital_base: 0, interest_days: 365, deed_interest_pct: "0", interest_pct: "0", interest: 0, working: true, deed_remuneration: 0, remuneration: 0, profit_share: "60", tds: 0, tds_section: null }] },
      { id: "h1", fy_start: 2024, posted_on: "2025-03-31", net_profit: 5, interest_total: 0, book_profit: 5, max_remuneration: 300000, remuneration_total: 0, residual: 5, tds_total: 0, created_at: "x", partner_appropriation_lines: [] },
    ];
    const s = toPostedSplits(rows as never);
    expect(s.map((x) => x.fyStart)).toEqual([2024, 2025]);
    expect(s[1].netProfit).toBe(100);
    expect(s[1].lines[0]).toMatchObject({ sharePct: 60, profitShare: 60 });
  });
});

describe("statutory dues include the partners' TDS (same rule as report_balance_sheet)", () => {
  it("₹84,000 of partner TDS is payable until a challan pays it", async () => {
    const d = await fetchStatutoryDues(fakeClient({ partner_appropriation_lines: [{ id: "1", tds: 49_333 }, { id: "2", tds: 34_667 }, { id: "3", tds: 0 }] }));
    expect(d.tdsVendor).toBe(84_000);
    expect(d.payable).toBe(84_000);
  });
  it("before the migration (no table) → 0, not an error", async () => {
    const d = await fetchStatutoryDues(fakeClient({}, ["partner_appropriation_lines"]));
    expect(d.tdsVendor).toBe(0);
  });
});
