import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { lineFromCatalog } from "./catalog-line";
import { markOneTimeLines } from "./line-commit-choice";
import { subscriptionExpectation } from "@/lib/subscriptions/orphan-quote";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

/* R-1688 + R-1686 follow-up (19 Oct 2026). Localhost Q-F588-27-0024: a custom line
   "T-M5 Email migration (one-time)" (Commit One-time = no commitment) was filed by "Invoice now"
   as an Annual subscription, MRR ₹417. A missing commitment is ambiguous in the database (older
   annual lines can lack one too), so every One-time line the builder saves now carries an
   EXPLICIT marker — `one_time: true` — and still no commitment, so its price stays × qty (R-1668). */

const MIGRATION_FLAGGED = {
  id: "M365-EM-t", name: "M365 Email migration (one-time)", vendor: "microsoft",
  item_type: "subscription", msrp: 199, wholesale: 80, prices: { billing_unit: "one_time" },
};
const GW_STD = {
  id: "GW-STD-t", name: "Google Workspace Business Standard", vendor: "google",
  item_type: "subscription", msrp: 1080, wholesale: 900,
  prices: { annual: { msrp: 1080, wholesale: 900 }, monthly: { msrp: 1296, wholesale: 1080 } },
};

const line = (l: Partial<QuoteLineItem>): QuoteLineItem =>
  ({ id: "l", name: "x", qty: 1, rate: 100, cost: 0, ...l }) as QuoteLineItem;

describe("R-1688 — the builder writes an explicit one-time marker", () => {
  it("a catalogue one-time item → one_time: true, no commitment, price once (× qty)", () => {
    const l = lineFromCatalog(MIGRATION_FLAGGED as never, { qty: 10 });
    expect(l.one_time).toBe(true);
    expect(l.commitment).toBeUndefined();
    expect(l.qty).toBe(1);
    expect(l.rate).toBe(199);
  });

  it("a licence row → annual commitment, no marker", () => {
    const l = lineFromCatalog(GW_STD as never, { qty: 10 });
    expect(l.commitment).toBe("annual_yearly");
    expect("one_time" in l).toBe(false);
  });

  it("on save, a custom line set to One-time (no commitment) gets the marker; price untouched", () => {
    const custom = line({ name: "T-M5 Email migration (one-time)", qty: 1, rate: 5000, list_rate: 5000 });
    const [saved] = markOneTimeLines([custom]);
    expect(saved.one_time).toBe(true);
    expect(saved.commitment).toBeUndefined();
    expect(saved.rate * saved.qty).toBe(5000);
    expect(saved.list_rate).toBe(5000);
  });

  it("on save, a line switched back to a term loses the marker", () => {
    const [annual, monthly] = markOneTimeLines([
      line({ commitment: "annual_yearly", one_time: true }),
      line({ commitment: "monthly", one_time: true }),
    ]);
    expect("one_time" in annual).toBe(false);
    expect(annual.commitment).toBe("annual_yearly");
    expect("one_time" in monthly).toBe(false);
  });

  it("does not change the caller's array (the draft snapshot stays as it is)", () => {
    const lines = [line({})];
    markOneTimeLines(lines);
    expect("one_time" in lines[0]).toBe(false);
  });

  it("the quote builder saves its lines through markOneTimeLines", () => {
    const src = readFileSync(join(__dirname, "../../components/features/quotes/quote-builder.tsx"), "utf8");
    expect(src).toMatch(/line_items:\s*markOneTimeLines\(lineItems\)/);
  });
});

describe("R-1688 — the app reads the marker the way the database does", () => {
  it("a marked line is a one-off, never a missing subscription (orphan-quote / rebuild)", () => {
    expect(subscriptionExpectation({ name: "Migration", qty: 1, rate: 5000, one_time: true })).toBe("one-off");
    expect(subscriptionExpectation({ name: "Migration", qty: 1, rate: 5000, commitment: "annual_yearly", one_time: true })).toBe("one-off");
    expect(subscriptionExpectation({ name: "GW", qty: 10, rate: 3000, commitment: "annual_yearly" })).toBe("annual");
  });

  it("every filing path uses the one SQL rule, quote_line_is_subscription", () => {
    const dir = join(__dirname, "../../../supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const fn of ["record_payment", "activate_quote_on_credit", "file_invoiced_quote_subscriptions"]) {
      const re = new RegExp(`create or replace function public\\.${fn}\\s*\\(`, "i");
      const latest = files.filter((f) => re.test(readFileSync(join(dir, f), "utf8"))).pop();
      expect(latest, fn).toBeTruthy();
      const sql = readFileSync(join(dir, latest!), "utf8");
      const body = sql.slice(sql.search(re));
      const end = body.search(/\n\$(function)?\$;?/);
      const fnBody = body.slice(0, end > 0 ? end : undefined);
      expect(fnBody, fn).toMatch(/public\.quote_line_is_subscription\(v_first_line, v_tenant_id, (true|false)\)/);
      // The NULL trap: `v_commitment = 'monthly'` is NULL with no commitment.
      expect(fnBody, fn).not.toMatch(/v_is_monthly\s*:=\s*v_commitment = 'monthly';/);
    }
  });
});
