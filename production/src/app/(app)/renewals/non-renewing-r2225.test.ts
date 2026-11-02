/**
 * R-2225: a subscription marked Won't renew (auto_renew off) leaves the Renewals urgency lists —
 * nobody chases a customer who already said no — but stays counted At risk while it runs.
 */
import { describe, it, expect } from "vitest";
import { classifyRenewals, chasedRenewal, type ClassifyRow } from "./classify";

const TODAY = new Date("2026-10-18T06:30:00Z");
type Row = ClassifyRow<{
  id: string; renewal_state: string | null; renewal_date: string | null; term_months: number;
  status: string; mrr: number; auto_renew?: boolean | null;
}>;
const row = (id: string, daysUntil: number, over: Partial<Row["sub"]> = {}): Row => ({
  daysUntil,
  sub: { id, renewal_state: "notice_sent", renewal_date: "2026-10-20", term_months: 12, status: "active", mrr: 1000, ...over },
});

describe("R-2225 classifyRenewals with non-renewing rows", () => {
  const rows = [
    row("renewing", 3),
    row("leaving-soon", 3, { auto_renew: false, mrr: 2000 }),
    row("leaving-later", 50, { auto_renew: false, mrr: 500 }),
    row("lapsed-leaver", -5, { auto_renew: false, status: "expired", renewal_state: "grace_period" }),
  ];
  const g = classifyRenewals(rows, () => false, TODAY);

  it("not in Urgent / Next 7 days / Future / Expired", () => {
    expect(g.urgentTab.map((r) => r.sub.id)).toEqual(["renewing"]);
    expect(g.due7.map((r) => r.sub.id)).toEqual(["renewing"]);
    expect(g.future).toEqual([]);
    expect(g.expired).toEqual([]);
  });

  it("listed apart as Non-renewing while it still runs, and counted At risk", () => {
    expect(g.nonRenewing.map((r) => r.sub.id)).toEqual(["leaving-soon", "leaving-later"]);
    expect(g.atRisk.map((r) => r.sub.id)).toEqual(["leaving-soon", "leaving-later"]);
    expect(g.atRiskArr).toBe((2000 + 500) * 12);
  });

  it("chasedRenewal is the one predicate (sidebar badge parity)", () => {
    expect(chasedRenewal({ auto_renew: false })).toBe(false);
    expect(chasedRenewal({ auto_renew: true })).toBe(true);
    expect(chasedRenewal({})).toBe(true);
  });
});

describe("R-2225 Bulk reminder skips a Won't renew row", () => {
  it("leaves it out even inside 30 days", async () => {
    const { bulkReminderTargets } = await import("./reminders");
    const rows = [
      { daysUntil: 5, sub: { id: "a", customer_name: "A", renewal_state: "notice_sent", renewal_date: "2026-10-23", term_months: 12 } },
      { daysUntil: 5, sub: { id: "b", customer_name: "B", renewal_state: "notice_sent", renewal_date: "2026-10-23", term_months: 12, auto_renew: false } },
    ];
    expect(bulkReminderTargets(rows, TODAY).map((r) => r.sub.id)).toEqual(["a"]);
  });
});
