/**
 * R-2431 — after R-2422 (Pardeep, 3 Nov: "monthly commitment to renewal hi hoga") a flex
 * (monthly-commitment) subscription is a renewal on the Renewals page. The places left behind:
 *   1. the sidebar badge (nav_badges SQL) must equal the Overdue + ≤7 days tab counts — the rows
 *      below are seeded the same way in supabase/tests/r2431_nav_badges_tabs.test.sql;
 *   2. Bulk reminder skips a flex part (its payment request goes out on its billing date) — the
 *      confirm now NAMES the skipped rows instead of leaving them out silently;
 *   3. Payment Follow-up lists an overdue flex part (collections/flex-renewal-r2431.test.ts);
 *   4. the 90-day export and the forecast use the row's renewal amount — the tiles' money.
 */
import { describe, it, expect } from "vitest";
import { classifyRenewals } from "./classify";
import { queueTabs } from "./queue";
import { bulkReminderPlan, bulkReminderConfirm, bulkReminderTargets } from "./reminders";
import { daysUntilRenewal, inRenewalsBadge } from "@/lib/renewals/buckets";
import { renewalForecast } from "@/lib/renewals/forecast";
import { termAmountOf } from "@/lib/billing/subscription-schedule";

const TODAY = new Date("2026-11-03T06:30:00Z"); // 12:00 IST
const d = (n: number) => new Date(Date.UTC(2026, 10, 3 + n)).toISOString().slice(0, 10);

interface Sub {
  id: string; customer_name: string; status: string; renewal_date: string; auto_renew?: boolean;
  term_months?: number; billing_cycle?: string; renewal_state?: string | null; renewal_quote_id?: string | null;
  mrr: number;
}
const sub = (p: Partial<Sub> & { id: string }): Sub => ({
  customer_name: p.id, status: "active", renewal_date: d(3), auto_renew: true, term_months: 12, billing_cycle: "yearly",
  renewal_state: "pending", renewal_quote_id: null, mrr: 1000, ...p,
});

/* The same rows as supabase/tests/r2431_nav_badges_tabs.test.sql. */
const BADGE_ROWS: Sub[] = [
  sub({ id: "flex-soon", renewal_date: d(3), term_months: 1, billing_cycle: "monthly" }),    // ≤7 — flex is a renewal (R-2422)
  sub({ id: "flex-today", renewal_date: d(0), term_months: 1, billing_cycle: "monthly" }),   // ≤7
  sub({ id: "flex-late", renewal_date: d(-2), term_months: 1, billing_cycle: "monthly" }),   // Overdue
  sub({ id: "annual-soon", renewal_date: d(5) }),                                             // ≤7
  sub({ id: "annual-late", renewal_date: d(-4) }),                                            // Overdue
  sub({ id: "wont-soon", renewal_date: d(4), auto_renew: false }),                            // ≤7 tab lists Won't-renew rows still running
  sub({ id: "wont-late", renewal_date: d(-1), auto_renew: false }),                           // Won't renew and past — no tab
  sub({ id: "paid-late", renewal_date: d(-3), renewal_quote_id: "Q-PAID" }),                  // renewal quote paid → not Overdue
  sub({ id: "stopped", renewal_date: d(-10), renewal_state: "suspended", renewal_quote_id: "Q-PAID" }), // Overdue (service stopped, even with a paid quote)
  sub({ id: "far", renewal_date: d(8) }),                                                     // 8–30 — no
];
const PAID_QUOTES = new Set(["Q-PAID"]);

describe("R-2431 (1): sidebar badge = Overdue + ≤7 days tabs", () => {
  const rows = BADGE_ROWS.map((s) => ({ sub: s, daysUntil: daysUntilRenewal(s.renewal_date, TODAY) }));
  const paid = (r: { sub: Sub }) => !!r.sub.renewal_quote_id && PAID_QUOTES.has(r.sub.renewal_quote_id);
  const tabs = queueTabs(classifyRenewals(rows, () => false, TODAY, paid));
  const tabIds = [...tabs.overdue, ...tabs.due7].map((r) => r.sub.id).sort();

  it("the page's Overdue + ≤7 days tabs hold 7 rows, flex ones included", () => {
    expect(tabIds).toEqual(["annual-late", "annual-soon", "flex-late", "flex-soon", "flex-today", "stopped", "wont-soon"]);
  });

  it("inRenewalsBadge (the rule nav_badges() runs in SQL) picks exactly those rows, less Won't renew (R-2225)", () => {
    const badge = rows.filter((r) => inRenewalsBadge(r.sub, r.daysUntil, paid(r))).map((r) => r.sub.id).sort();
    expect(badge).toEqual(tabIds.filter((id) => !id.startsWith("wont-")));
    expect(badge).toHaveLength(6);   // = r2431_nav_badges_tabs.test.sql
  });
});

describe("R-2431 (2): Bulk reminder names the flex rows it skips", () => {
  const rows = [
    sub({ id: "Acme", renewal_date: d(10) }),
    sub({ id: "Flexy Traders", renewal_date: d(6), term_months: 1, billing_cycle: "monthly" }),
    sub({ id: "Monthly Mart", renewal_date: d(20), term_months: 1, billing_cycle: "monthly" }),
    sub({ id: "Not yet", renewal_date: d(45), term_months: 1, billing_cycle: "monthly" }),   // outside 30 days — not a skip
  ].map((s) => ({ sub: s, daysUntil: daysUntilRenewal(s.renewal_date, TODAY) }));

  it("send = the annual one; skipped = the two flex parts in the window, with the reason", () => {
    const plan = bulkReminderPlan(rows, TODAY, 0);
    expect(plan.send.map((r) => r.sub.id)).toEqual(["Acme"]);
    expect(plan.skipped.map((s) => s.row.sub.id)).toEqual(["Flexy Traders", "Monthly Mart"]);
    expect(plan.skipped[0].reason).toMatch(/monthly \(flex\)/i);
    expect(bulkReminderTargets(rows, TODAY, 0)).toEqual(plan.send);
  });

  it("the confirm names the skipped rows", () => {
    const plan = bulkReminderPlan(rows, TODAY, 0);
    const c = bulkReminderConfirm(plan.send, plan.skipped);
    expect(c.title).toBe("Email 1 customer?");
    expect(c.body).toContain("Not emailed (2)");
    expect(c.body).toContain("Flexy Traders");
    expect(c.body).toContain("Monthly Mart");
  });

  it("no skip line when nothing is skipped", () => {
    expect(bulkReminderConfirm(rows.slice(0, 1)).body).not.toContain("Not emailed");
  });
});

describe("R-2431 (4): forecast uses the term amount (the tiles' amount before GST) and counts flex in the total", () => {
  const today = "2026-11-03";
  it("an annual row adds its term amount (term_amount wins over mrr×12)", () => {
    const f = renewalForecast([{ status: "active", mrr: 9046, term_months: 12, term_amount: 108000, renewal_date: "2026-12-01" } as never], today);
    expect(f.months.find((m) => m.key === "2026-12")!.amount).toBe(108000);
  });

  it("a flex row adds one part per month from its date — the same part the tiles add — and is IN the total", () => {
    const flex = { status: "active", mrr: 4875, term_months: 1, billing_cycle: "monthly", term_amount: null, renewal_date: "2026-11-20" };
    const f = renewalForecast([flex as never], today);
    const part = termAmountOf({ mrr: 4875, term_months: 1, term_amount: null });
    expect(f.months.map((m) => m.amount)).toEqual([part, part, part, part, part, part]);
    expect(f.totalAmount).toBe(part * 6);
    expect(f.flexCount).toBe(1);
  });

  it("a 3-month term falls in its month and again 3 months later", () => {
    const f = renewalForecast([{ status: "active", mrr: 1000, term_months: 3, term_amount: null, renewal_date: "2026-11-25" } as never], today);
    expect(f.months.map((m) => m.amount)).toEqual([3000, 0, 0, 3000, 0, 0]);
  });
});
