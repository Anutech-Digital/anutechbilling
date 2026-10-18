import { describe, it, expect } from "vitest";
import { OBLIGATIONS, buildComplianceRows } from "./obligations";
import { tdsDepositDueDate } from "./tds-due";

/**
 * R-1583 (P1) — "Deposit TDS deducted" (challan 281). Rule 30(1) of the Income-tax Rules:
 * TDS deducted in a month is deposited by the 7th of the next month, EXCEPT tax deducted in
 * March, which is due by 30 April. The catalog said so in its own text ("Mar TDS → 30 Apr")
 * but computed every period as the 7th — so the March period showed "overdue" from 8 to
 * 30 April, the reminder cron sent "late" mails and /today listed it red.
 */

const tdsDeposit = OBLIGATIONS.find((o) => o.key === "tds_payment")!;
const filedFeb = (y: number) => new Map([[`tds_payment|${y}-02`, `${y}-03-05`]]);
const row = (today: Date, filed: Map<string, string>) =>
  buildComplianceRows(today, filed, ["tds"]).find((r) => r.ob.key === "tds_payment")!;

describe("R-1583 — March TDS is due 30 April, not 7 April", () => {
  it("on 10 April the March period is NOT overdue and is due 30 April", () => {
    const today = new Date("2027-04-10T12:00:00+05:30");
    const r = row(today, filedFeb(2027));
    expect(r.inst.periodKey).toBe("2027-03");
    expect(r.inst.dueDate).toBe("2027-04-30");
    expect(r.status).not.toBe("overdue");
    expect(r.daysToDue).toBe(20);
  });

  it("on 30 April it is still not overdue (due today)", () => {
    const r = row(new Date("2027-04-30T09:00:00+05:30"), filedFeb(2027));
    expect(r.inst.periodKey).toBe("2027-03");
    expect(r.status).toBe("due_soon");
    expect(r.daysToDue).toBe(0);
  });

  it("on 1 May an unfiled March deposit IS overdue", () => {
    const r = row(new Date("2027-05-01T09:00:00+05:30"), filedFeb(2027));
    expect(r.inst.periodKey).toBe("2027-03");
    expect(r.status).toBe("overdue");
  });

  it("the October period is due 7 November", () => {
    const inst = tdsDeposit.next(new Date("2026-11-02T12:00:00+05:30"), (p) => p === "2026-09");
    expect(inst.periodKey).toBe("2026-10");
    expect(inst.dueDate).toBe("2026-11-07");
  });

  it("the April period (paid in May) is due 7 May — only March moves", () => {
    const inst = tdsDeposit.next(new Date("2027-05-02T12:00:00+05:30"), (p) => p <= "2027-03");
    expect(inst.periodKey).toBe("2027-04");
    expect(inst.dueDate).toBe("2027-05-07");
  });

  it("once March is filed it moves on to April (due 7 May)", () => {
    const filed = new Map([...filedFeb(2027), ["tds_payment|2027-03", "2027-04-25"]]);
    const r = row(new Date("2027-04-26T12:00:00+05:30"), filed);
    expect(r.inst.periodKey).toBe("2027-04");
    expect(r.inst.dueDate).toBe("2027-05-07");
  });
});

describe("tdsDepositDueDate — the one helper every screen reads", () => {
  it.each([
    ["2027-03", "2027-04-30"],
    ["2026-10", "2026-11-07"],
    ["2026-12", "2027-01-07"],
    ["2027-04", "2027-05-07"],
    ["2027-02", "2027-03-07"],
  ])("%s → %s", (period, due) => expect(tdsDepositDueDate(period)).toBe(due));

  it("rejects a non-month", () => {
    expect(() => tdsDepositDueDate("2027")).toThrow();
    expect(() => tdsDepositDueDate("2027-13")).toThrow();
  });
});
