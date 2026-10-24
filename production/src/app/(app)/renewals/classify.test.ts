/**
 * R-1124 — one classification for /renewals: expired rows are their own group, the header's
 * "at risk" is the High risk set, and Bulk reminder reaches a lapsed row still in grace.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { classifyRenewals, expiredGraceText, type ClassifyRow } from "./classify";
import { bulkReminderTargets, bulkReminderConfirm, type RenewalRowLike } from "./reminders";

const TODAY = new Date("2026-10-18T06:30:00Z"); // 12:00 IST

type Row = ClassifyRow<{
  id: string; customer_name: string; renewal_state: string | null; renewal_date: string | null;
  term_months: number; status: string; mrr: number; grace_until?: string | null; high?: boolean;
}>;
const row = (id: string, daysUntil: number, over: Partial<Row["sub"]> = {}): Row => ({
  daysUntil,
  sub: {
    id, customer_name: id.toUpperCase(), renewal_state: "notice_sent", renewal_date: "2026-10-20",
    term_months: 12, status: "active", mrr: 1000, ...over,
  },
});
const high = (r: Row) => r.sub.high === true;

describe("R-1124 classifyRenewals", () => {
  const rows = [
    row("lapsed", -3, { renewal_state: "grace_period", renewal_date: "2026-10-15", mrr: 2000 }),
    row("stopped", -10, { renewal_state: "suspended", renewal_date: "2026-10-08" }),
    row("today", 0),
    row("week", 7, { high: true }),
    row("month", 20),
    row("later", 60, { high: true, mrr: 500 }),
    row("paidhigh", 40, { high: true, renewal_state: "renewed", renewal_date: "2026-11-27" }),
  ];
  const g = classifyRenewals(rows, high, TODAY);

  it("an expired row is in its own group, never in 'Next 7 days'", () => {
    expect(g.expired.map((r) => r.sub.id)).toEqual(["lapsed"]);
    expect(g.due7.map((r) => r.sub.id)).toEqual(["today", "week"]);
    expect(g.stopped.map((r) => r.sub.id)).toEqual(["stopped"]);
  });

  it("the Urgent tab still holds expired + next 7 days + stopped (sidebar badge parity, R-1541)", () => {
    expect(g.urgentTab.map((r) => r.sub.id).sort()).toEqual(["lapsed", "stopped", "today", "week"]);
  });

  it("at risk = expired unpaid + high-risk within 90 days, paid renewals out; header == card", () => {
    expect(g.atRisk.map((r) => r.sub.id)).toEqual(["lapsed", "week", "later"]);
    expect(g.atRiskArr).toBe((2000 + 1000 + 500) * 12);
  });
});

describe("R-1124 expired row says the real stop date", () => {
  it("in grace: the IST day after the last grace day", () => {
    expect(expiredGraceText({ renewal_date: "2026-10-15" }, -3, 7)).toBe("In grace · service stops 23 Oct 2026 if unpaid");
  });
  it("the owner's +N days moves it", () => {
    expect(expiredGraceText({ renewal_date: "2026-10-15", grace_until: "2026-10-30" }, -10, 7))
      .toBe("In grace · service stops 31 Oct 2026 if unpaid");
  });
  it("grace over: the owner decides (nothing stops by itself)", () => {
    expect(expiredGraceText({ renewal_date: "2026-10-01" }, -17, 7)).toBe("Grace over — owner decides (Grace over list)");
  });
  it("nothing for a row not yet due", () => {
    expect(expiredGraceText({ renewal_date: "2026-10-20" }, 2, 7)).toBeNull();
  });
});

describe("R-1124 bulk reminder reaches lapsed rows still in grace", () => {
  const sub = (id: string, over: Partial<RenewalRowLike["sub"]> = {}): RenewalRowLike["sub"] => ({
    id, customer_name: id, renewal_state: "grace_period", renewal_date: "2026-10-15", term_months: 12, ...over,
  });
  it("3 days past renewal, not suspended → targeted; suspended → not; past grace → not", () => {
    const t = bulkReminderTargets([
      { sub: sub("lapsed3"), daysUntil: -3 },
      { sub: sub("suspended", { renewal_state: "suspended" }), daysUntil: -3 },
      { sub: sub("graceover", { renewal_date: "2026-10-01" }), daysUntil: -17 },
      { sub: sub("soon", { renewal_state: "notice_sent", renewal_date: "2026-10-25" }), daysUntil: 7 },
    ], TODAY, 7);
    expect(t.map((r) => r.sub.id)).toEqual(["lapsed3", "soon"]);
  });
  it("the confirm names the lapsed ones separately", () => {
    const c = bulkReminderConfirm([
      { sub: sub("Lapsed Co"), daysUntil: -3 },
      { sub: sub("Soon Co", { renewal_state: "notice_sent" }), daysUntil: 7 },
    ]);
    expect(c.body).toContain("1 already past the renewal date (in grace): Lapsed Co");
  });
});

describe("R-1124 page wiring", () => {
  const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
  it("header 'at risk' and the High risk card read the same number", () => {
    expect(page).toContain("classifyRenewals(");
    expect(page).not.toMatch(/const arrAtRisk/);
    expect(page.match(/groups\.atRiskArr/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
  it("the Urgent tab shows an 'Expired · in grace' group apart from 'Next 7 days'", () => {
    expect(page).toContain('title="Expired · in grace"');
    expect(page).toContain("rows={shown(groups.expired)}");
    expect(page).toContain("rows={shown(groups.due7)}");
  });
  it("bulk reminder passes the company grace", () => {
    expect(page).toMatch(/bulkReminderTargets\(enriched, today, graceDays\)/);
  });
});
