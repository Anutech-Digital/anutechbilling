/**
 * R-2756 (user audit 14 Nov, job 5/9): one overdue-days number per row in every place, and a
 * Won't-renew / stopped customer is never "Top risk".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renewalStage } from "@/lib/renewals/stage";
import { riskChased, riskCandidate, stageOverdueWords, topRiskPick, topRiskReasons } from "./risk";

const TODAY = "2026-11-14";
const riskSub = { seats: 5, used: 0, outstanding_amount: 0, plan: "Business", used_synced_at: null as string | null };

/* Greentin Check 2095: monthly (flex) parts, renewal_date 31 Oct; the Oct part invoice (due 1 Oct) unpaid. */
const greentin = {
  ...riskSub, status: "active", auto_renew: true, renewal_date: "2026-10-31", term_months: 12,
  billing_cycle: "monthly", start_date: "2025-11-01",
};
const greentinStage = renewalStage({
  sub: greentin, todayIst: TODAY,
  invoice: { id: "inv-oct", kind: "part", amountDue: 1180, dueDate: "2026-10-01", period: "Oct 2026" },
});

describe("R-2756: one day count, naming what it counts from", () => {
  it("the AI words use the chip's own day count (44d from the part's due date), not renewal_date's 14d", () => {
    expect(greentinStage.key).toBe("invoiced");
    expect(greentinStage.days).toBe(-44);
    expect(greentinStage.label).toMatch(/44d/);
    const words = stageOverdueWords(greentinStage, TODAY);
    expect(words).toBe("Part bill overdue 44d (due 1 Oct 2026)");
    expect(words).not.toMatch(/14d/);
  });

  it("a whole-term renewal names the renewal date it counts from", () => {
    const st = renewalStage({ sub: { ...greentin, billing_cycle: "annual" }, todayIst: TODAY });
    expect(st.key).toBe("due");
    expect(stageOverdueWords(st, TODAY)).toBe("Renewal date passed 14d ago (31 Oct 2026)");
  });

  it("no stage yet (documents loading) / not overdue / Won't renew → no words, never a guessed number", () => {
    expect(stageOverdueWords(null, TODAY)).toBeNull();
    expect(stageOverdueWords({ key: "due", days: 5, renewalDays: 5 }, TODAY)).toBeNull();
    const ending = renewalStage({ sub: { ...greentin, auto_renew: false }, todayIst: TODAY });
    expect(ending.key).toBe("ending");
    expect(stageOverdueWords(ending, TODAY)).toBeNull();
  });

  it("the AI reasons start with the same words as the row", () => {
    const reasons = topRiskReasons({ sub: greentin, stage: greentinStage, daysUntil: -14, atRisk: true }, TODAY);
    expect(reasons[0]).toBe("Part bill overdue 44d (due 1 Oct 2026)");
    expect(reasons).not.toContain("Seat usage not checked");
  });
});

describe("R-2756: Won't renew / stopped / paused / expired are not Top risk", () => {
  it("riskChased", () => {
    expect(riskChased({ auto_renew: true, status: "active" })).toBe(true);
    expect(riskChased({ auto_renew: false, status: "active" })).toBe(false);
    for (const status of ["cancelled", "paused", "expired", "suspended"]) expect(riskChased({ status })).toBe(false);
    expect(riskChased({ status: "active", renewal_state: "suspended" })).toBe(false);
  });

  it("SCN Kochi marked Won't renew is skipped; the most overdue chased row is Top risk", () => {
    const kochi = { sub: { auto_renew: false, status: "active" }, stage: { key: "ending", days: 20, renewalDays: 20 }, daysUntil: 20, atRisk: true, name: "SCN Kochi" };
    const paused = { sub: { status: "paused" }, stage: { key: "stopped", days: -60, renewalDays: -60 }, daysUntil: -60, atRisk: true, name: "Paused Co" };
    const g = { sub: { status: "active" }, stage: greentinStage, daysUntil: -14, atRisk: true, name: "Greentin" };
    const later = { sub: { status: "active" }, stage: { key: "due", days: 10, renewalDays: 10 }, daysUntil: 10, atRisk: true, name: "Later" };
    expect(topRiskPick([kochi, paused, later, g])?.name).toBe("Greentin");
    expect(topRiskPick([kochi, paused])).toBeNull();
    expect(riskCandidate(kochi)).toBe(false);
    expect(riskCandidate({ ...g, atRisk: false })).toBe(false);
  });

  it("a row whose stage is not read yet orders by its renewal days", () => {
    const a = { sub: { status: "active" }, stage: null, daysUntil: -3, atRisk: true };
    const b = { sub: { status: "active" }, stage: null, daysUntil: 4, atRisk: true };
    expect(topRiskPick([b, a])).toBe(a);
  });

  it("Won't renew rows get no Nudge / Voice note / Follow up (stage model)", async () => {
    const { renewalPrimary } = await import("@/lib/renewals/stage");
    const st = renewalStage({ sub: { ...greentin, auto_renew: false, renewal_date: "2026-12-15" }, todayIst: TODAY });
    const acts = renewalPrimary(st, { renewal_date: "2026-12-15" }, {
      role: "owner", canEndSubscription: true, tenantGraceDays: 7, offers: { followup: true, messaging: true },
    });
    expect(acts.primary).toBeNull();
    expect(acts.menu).not.toContain("nudge");
    expect(acts.menu).not.toContain("voice");
    expect(acts.menu).not.toContain("follow-up");
  });
});

describe("R-2756: the page reads these helpers (no third day-count rule)", () => {
  const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
  it("Top risk + AI reasons come from topRiskPick / topRiskReasons", () => {
    expect(page).toMatch(/topRiskPick\(/);
    expect(page).toMatch(/topRiskReasons\(/);
    expect(page).not.toMatch(/Renewal \$\{Math\.abs\([^)]*daysUntil\)\}d overdue/);
    expect(page).not.toMatch(/highRiskSubs\[0\]/);
  });
  it("the row's at-risk flag is only on a chased row", () => {
    expect(page).toMatch(/atRisk: atRiskIds\.has\(r\.sub\.id\) && riskChased\(r\.sub\)/);
  });
});
