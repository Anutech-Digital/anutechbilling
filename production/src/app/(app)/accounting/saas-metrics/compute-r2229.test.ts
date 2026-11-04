import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { computeSaasMetrics, type SubRow } from "./compute";
import { mrrOf, recurringMrr, totalMrr, isRecurringSub } from "@/lib/subscriptions/mrr-of";
import { computeMrrAnalytics } from "@/lib/subscriptions/mrr-analytics";
import { subscriptionSummary } from "@/lib/company/summary";

/* R-2229 (Zoho Billing audit A5). Localhost E2E Test Co, 1 Nov 2026: SaaS Metrics card summed
   status = active (₹2,04,822), the waterfall's Ending summed every row not cancelled/expired
   (+ ₹690 of a PAUSED sub), and both counted "T-M5 Email migration (one-time)" — ₹417 a month
   that will never recur. One rule now: mrrOf(sub). */

const NOW = new Date("2026-11-01T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

const row = (r: Partial<SubRow> & Pick<SubRow, "id" | "mrr" | "status">): SubRow => ({
  customer_id: r.id, customer_name: r.id, plan: "Google Workspace Business Starter", vendor: "google",
  seats: 1, start_date: "2025-01-01", renewal_date: null, updated_at: "2025-01-01T00:00:00Z",
  term_months: 12, ...r,
});

const SUBS: SubRow[] = [
  row({ id: "a", mrr: 2700, status: "active" }),
  row({ id: "b", mrr: 1500, status: "active", term_months: 1, vendor: "microsoft", plan: "Microsoft 365 Business Standard", start_date: daysAgo(10) }),
  row({ id: "paused", mrr: 690, status: "paused", start_date: "2026-10-01", updated_at: `${daysAgo(5)}T00:00:00Z` }),
  row({ id: "migration", mrr: 417, status: "active", plan: "T-M5 Email migration (one-time)", start_date: daysAgo(13) }),
  row({ id: "no-term", mrr: 300, status: "active", term_months: 0, plan: "Setup help" }),
  row({ id: "gone", mrr: 2700, status: "cancelled", updated_at: `${daysAgo(3)}T00:00:00Z` }),
];
const EXPECTED_MRR = 2700 + 1500;

describe("R-2229 — mrrOf: one-time and no-term lines never count", () => {
  it("a one-time line adds 0, whatever its stored mrr", () => {
    expect(mrrOf({ status: "active", mrr: 417, term_months: 12, plan: "T-M5 Email migration (one-time)" })).toBe(0);
    expect(mrrOf({ status: "active", mrr: 417, plan: "Onetime setup" })).toBe(0);
    expect(isRecurringSub({ plan: "One time migration", term_months: 12 })).toBe(false);
  });
  it("no recurring term adds 0", () => {
    expect(mrrOf({ status: "active", mrr: 300, term_months: 0 })).toBe(0);
    expect(mrrOf({ status: "active", mrr: 300, term_months: null })).toBe(0);
  });
  it("a recurring active sub adds its stored mrr; paused/cancelled add 0 today", () => {
    expect(mrrOf({ status: "active", mrr: 2700, term_months: 12, plan: "Business Starter" })).toBe(2700);
    expect(mrrOf({ status: "paused", mrr: 690, term_months: 12 })).toBe(0);
    expect(recurringMrr({ status: "cancelled", mrr: 2700, term_months: 12 })).toBe(2700);
  });
  it("totalMrr of the sample = the two recurring active subs", () => {
    expect(totalMrr(SUBS)).toBe(EXPECTED_MRR);
  });
});

describe("R-2229 — SaaS Metrics card = waterfall Ending = Subscriptions strip = dashboard", () => {
  const m = computeSaasMetrics(SUBS, NOW);

  it("the card is the one MRR", () => {
    expect(m.mrr).toBe(EXPECTED_MRR);
    expect(m.arr).toBe(EXPECTED_MRR * 12);
  });
  it("waterfall Ending MRR equals the card (paused and one-time rows do not slip in)", () => {
    expect(m.waterfall.endingMrr).toBe(m.mrr);
  });
  it("the Subscriptions strip / dashboard tile (totalMrr, subscriptionSummary) equal the card", () => {
    expect(totalMrr(SUBS)).toBe(m.mrr);
    const folderRows = SUBS.map((s) => ({ ...s, renewal_date: s.renewal_date, status: s.status }));
    expect(subscriptionSummary(folderRows as never, NOW).mrr).toBe(m.mrr);
  });
  it("vendor and tier splits add up to the card", () => {
    expect(m.mrrByVendor.reduce((a, v) => a + v.mrr, 0)).toBe(m.mrr);
    expect(m.mrrByTier.reduce((a, v) => a + v.mrr, 0)).toBe(m.mrr);
    expect(m.mrrByVendor.some((v) => v.mrr === 0 && v.count > 0)).toBe(false);
  });
  it("New MRR (30 days) leaves out the one-time line", () => {
    expect(m.newMRR30d).toBe(1500);
    expect(m.waterfall.newMrr).toBe(1500);
  });
  it("v1 analytics (vendor split API) total equals the card", () => {
    const a = computeMrrAnalytics(SUBS.map((s) => ({ ...s, vendor_cost_per_seat_month: null })));
    expect(a.total_mrr_rupees).toBe(m.mrr);
    expect(a.total_active_subscriptions).toBe(2);
  });
});

describe("R-2229 — every MRR total reads the one helper (wiring)", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const FILES = [
    "src/app/(app)/accounting/saas-metrics/compute.ts",
    "src/app/(app)/subscriptions/page.tsx",
    "src/app/(app)/dashboard/page.tsx",
    "src/lib/company/summary.ts",
    "src/lib/subscriptions/mrr-analytics.ts",
    "src/app/api/cron/mrr-snapshot/route.ts",
  ];
  it.each(FILES)("%s imports mrr-of", (f) => {
    expect(src(f)).toMatch(/from "@\/lib\/subscriptions\/mrr-of"/);
  });
  it.each(FILES)("%s has no raw `+ (x.mrr ?? 0)` MRR sum left", (f) => {
    expect(src(f)).not.toMatch(/\+\s*\(?\s*\w+\.mrr\s*\?\?\s*0\s*\)?\s*,\s*0\)/);
  });
});
