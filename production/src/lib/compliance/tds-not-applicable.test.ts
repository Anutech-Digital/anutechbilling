import { describe, it, expect } from "vitest";
import { buildComplianceRows } from "./obligations";
import { noTdsDeductedPredicate, tdsMonthsFrom } from "./tds-not-applicable";

/**
 * R-181 — "Deposit TDS deducted — Aug 2026, 29 days overdue" showed in red for a
 * company that deducted no TDS in August (Month-end Close said "nothing withheld").
 * No TDS deducted → there is nothing to deposit, so the month is N/A, not overdue.
 */
const OCT_6_2026 = new Date("2026-10-06T12:00:00+05:30");
const tdsRow = (months: Set<string> | null) =>
  buildComplianceRows(OCT_6_2026, new Map(), ["tds"], months ? noTdsDeductedPredicate(months, OCT_6_2026) : undefined)
    .find((r) => r.ob.key === "tds_payment")!;

describe("Deposit TDS — months with no TDS are not applicable (R-181)", () => {
  it("before the fix, with no TDS data it still shows Aug as overdue (unchanged default)", () => {
    const r = tdsRow(null);
    expect(r.inst.periodKey).toBe("2026-08");
    expect(r.status).toBe("overdue");
  });

  it("no TDS in Aug + Sep → skips both and shows the Oct deposit as upcoming", () => {
    const r = tdsRow(new Set());
    expect(r.status).not.toBe("overdue");
    expect(r.inst.periodKey).toBe("2026-10");
    expect(r.status).toBe("upcoming");
  });

  it("TDS deducted in Aug → Aug deposit stays overdue", () => {
    const r = tdsRow(new Set(["2026-08"]));
    expect(r.inst.periodKey).toBe("2026-08");
    expect(r.status).toBe("overdue");
  });

  it("TDS only in Sep → Sep deposit (due 7 Oct) is due soon", () => {
    const r = tdsRow(new Set(["2026-09"]));
    expect(r.inst.periodKey).toBe("2026-09");
    expect(r.status).toBe("due_soon");
  });

  it("never marks the running month N/A — it is not over yet", () => {
    const na = noTdsDeductedPredicate(new Set(), OCT_6_2026);
    expect(na("tds_payment", "2026-10")).toBe(false);
    expect(na("tds_payment", "2026-09")).toBe(true);
  });

  it("only touches the TDS deposit, never other obligations", () => {
    const na = noTdsDeductedPredicate(new Set(), OCT_6_2026);
    expect(na("gst_gstr3b", "2026-08")).toBe(false);
    expect(na("tds_return", "2026-q1")).toBe(false);
    expect(na("pf_ecr", "2026-08")).toBe(false);
  });

  it("every past month N/A → row reads not_applicable, never overdue", () => {
    const all = () => true;
    const r = buildComplianceRows(OCT_6_2026, new Map(), ["tds"], all).find((x) => x.ob.key === "tds_payment")!;
    expect(r.status).toBe("not_applicable");
  });
});

describe("tdsMonthsFrom — which months had TDS", () => {
  it("collects salary periods and expense months with TDS > 0", () => {
    const s = tdsMonthsFrom(
      [{ period: "2026-08", tds: 1200 }, { period: "2026-07", tds: 0 }, { period: "2026-06", tds: null }],
      [{ expense_date: "2026-09-14", tds_amount: 500 }, { expense_date: "2026-05-02", tds_amount: 0 }],
    );
    expect([...s].sort()).toEqual(["2026-08", "2026-09"]);
  });
});

describe("/today inbox and reminder email follow the same N/A (R-181)", () => {
  it("no 'Deposit TDS' LATE item on /today when no TDS was deducted", async () => {
    const { complianceTodayItems } = await import("@/lib/today/inbox");
    const before = complianceTodayItems(OCT_6_2026, new Map()).filter((i) => i.id.startsWith("tds_payment|"));
    expect(before.length).toBe(1); // the old false alarm
    const after = complianceTodayItems(OCT_6_2026, new Map(), noTdsDeductedPredicate(new Set(), OCT_6_2026))
      .filter((i) => i.id.startsWith("tds_payment|"));
    expect(after).toEqual([]);
  });

  it("a not_applicable row never gets a reminder rung", async () => {
    const { reminderStepFor } = await import("./reminders");
    expect(reminderStepFor({ status: "not_applicable", daysToDue: 1 })).toBeNull();
  });
});
