import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { catalogLineListRate, lineFromCatalog } from "./catalog-line";
import { commitmentForChoice } from "./line-commit-choice";

/* R-1668: staging 19 Oct, Q-5F40-27-0090 — "M365 Email migration (one-time)" (catalogue ₹199)
   was ₹2,388/seat (×12) even with Commit set to One-time; 10 seats = ₹23,880 instead of ₹1,990.
   The staging row predates R-526 (no billing unit), so it reads as ₹/seat/month. Choosing
   One-time must still charge the catalogue price ONCE per unit. */
const MIGRATION_OLD = {
  id: "M365-EM-t", name: "M365 Email migration (one-time)", vendor: "microsoft",
  item_type: "subscription", msrp: 199, wholesale: 80, prices: {},
};
const MIGRATION_FLAGGED = { ...MIGRATION_OLD, prices: { billing_unit: "one_time" } };
const GW_STD = {
  id: "GW-STD-t", name: "Google Workspace Business Standard", vendor: "google",
  item_type: "subscription", msrp: 1080, wholesale: 900,
  prices: { annual: { msrp: 1080, wholesale: 900 }, monthly: { msrp: 1296, wholesale: 1080 } },
};

describe("R-1668 — a One-time line is the catalogue price × qty, never × 12", () => {
  it("Commit = One-time on a per-month catalogue row → ₹199 a unit, 10 = ₹1,990", () => {
    const p = catalogLineListRate(MIGRATION_OLD as never, commitmentForChoice("one_time"));
    expect(p.rate).toBe(199);
    expect(p.cost).toBe(80);
    expect(p.rate * 10).toBe(1990);
  });

  it("a one-time line on a licence row is its catalogue price once too", () => {
    expect(catalogLineListRate(GW_STD as never, null).rate).toBe(1080);
    expect(catalogLineListRate(GW_STD as never, undefined).rate).toBe(1080);
  });

  it("annual and monthly lines keep their R-369 units", () => {
    expect(catalogLineListRate(MIGRATION_OLD as never, "annual_yearly").rate).toBe(2388);
    expect(catalogLineListRate(GW_STD as never, "annual_yearly").rate).toBe(12_960);
    expect(catalogLineListRate(GW_STD as never, "monthly").rate).toBe(1296);
  });

  it("USD basis: a one-time line is the USD price × rate once", () => {
    expect(catalogLineListRate(MIGRATION_OLD as never, null, { msrp: 3, wholesale: 1, fx: 85 })).toEqual({ rate: 255, cost: 85 });
    expect(catalogLineListRate(MIGRATION_OLD as never, "annual_yearly", { msrp: 3, wholesale: 1, fx: 85 }).rate).toBe(3060);
  });

  it("a catalogue item flagged one-time: default term One-time, qty 1, price once", () => {
    const l = lineFromCatalog(MIGRATION_FLAGGED as never, { qty: 10 });
    expect(l.commitment).toBeUndefined();
    expect(l.qty).toBe(1);
    expect(l.rate).toBe(199);
  });
});

describe("R-1668 — a one-time line never becomes a subscription (so never MRR)", () => {
  it("One-time saves NO commitment", () => {
    expect(commitmentForChoice("one_time")).toBeNull();
    expect(lineFromCatalog(MIGRATION_FLAGGED as never).commitment).toBeUndefined();
  });

  it("record_payment files a subscription only for a line WITH a commitment", () => {
    const dir = join(__dirname, "../../../supabase/migrations");
    const latest = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) => /create or replace function public\.record_payment\s*\(/i.test(readFileSync(join(dir, f), "utf8")))
      .pop();
    expect(latest).toBeTruthy();
    const sql = readFileSync(join(dir, latest!), "utf8");
    expect(sql).toMatch(/v_is_annual\s*:=\s*v_commitment is distinct from 'monthly' and v_commitment is not null/);
    expect(sql).toMatch(/if \(v_is_annual or v_is_monthly\) and v_customer_id is not null then/);
  });
});

describe("quote builder wiring (R-1668)", () => {
  const src = readFileSync(join(__dirname, "../../components/features/quotes/quote-builder.tsx"), "utf8");
  it("the catalogue re-price reads the line's OWN commitment — a one-time line is not 'annual'", () => {
    expect(src).not.toMatch(/const lineCommitment = l\.commitment \?\? "annual_yearly";/);
    expect(src).toMatch(/catalogLineListRate\(it, l\.commitment/);
  });
  it("switching a catalogue line to One-time re-prices it from the catalogue", () => {
    expect(src).toMatch(/catalogLineListRate\(item, null, usdFor\(item\)\)/);
  });
});
