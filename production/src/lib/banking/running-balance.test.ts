/* R-2400 — running Balance after each bank line (owner, 3 Nov: "od account me running balance bhi
   har row me show karo"). One helper; the newest line equals the page's "Balance in bank". */
import { describe, expect, it } from "vitest";

import { applyBankFilters, DEFAULT_FILTERS } from "./bank-filters";
import { balanceText, bankBalanceOf, ledgerOrder, runningBalances, type RunningLine } from "./running-balance";

const line = (id: string, txn_date: string, debit: number, credit: number, balance_after: number | null = null, created_at = "2026-11-01T00:00:00Z"): RunningLine =>
  ({ id, txn_date, debit, credit, balance_after, created_at });

describe("R-2400 runningBalances", () => {
  it("opening + mixed lines, in date order whatever order they come in; newest = bankBalanceOf", () => {
    const lines = [
      line("c", "2026-04-05", 0, 2000),
      line("a", "2026-04-01", 0, 5000),
      line("b", "2026-04-03", 1500, 0),
    ];
    const r = runningBalances(lines, 10_000);
    expect(r.get("a")?.balance).toBe(15_000);
    expect(r.get("b")?.balance).toBe(13_500);
    expect(r.get("c")?.balance).toBe(15_500);
    expect(r.get("c")?.balance).toBe(bankBalanceOf(lines, 10_000));
    expect(ledgerOrder(lines).map((l) => l.id)).toEqual(["a", "b", "c"]);
  });

  it("same day: follows the statement's own balance chain, not the random uuid order", () => {
    // Statement order on 2 Apr: salary 30,000 out (→ 70,000), then 50,000 in (→ 1,20,000), then 5,000 out (→ 1,15,000).
    const lines = [
      line("a-first-day", "2026-04-01", 0, 100_000, 100_000),
      line("zz", "2026-04-02", 30_000, 0, 70_000),
      line("mm", "2026-04-02", 5_000, 0, 115_000),
      line("aa", "2026-04-02", 0, 50_000, 120_000),
    ];
    const r = runningBalances(lines, 0);
    expect(ledgerOrder(lines).map((l) => l.id)).toEqual(["a-first-day", "zz", "aa", "mm"]);
    expect(r.get("zz")?.balance).toBe(70_000);
    expect(r.get("aa")?.balance).toBe(120_000);
    expect(r.get("mm")?.balance).toBe(115_000);
    for (const v of r.values()) expect(v.statementSays).toBeNull();
  });

  it("same day with no statement balance: created_at, then id", () => {
    const lines = [
      line("b", "2026-04-02", 100, 0, null, "2026-11-01T10:00:00Z"),
      line("c", "2026-04-02", 200, 0, null, "2026-11-01T09:00:00Z"),
      line("a", "2026-04-02", 300, 0, null, "2026-11-01T10:00:00Z"),
    ];
    expect(ledgerOrder(lines).map((l) => l.id)).toEqual(["c", "a", "b"]);
    const r = runningBalances(lines, 1000);
    expect([r.get("c")?.balance, r.get("a")?.balance, r.get("b")?.balance]).toEqual([800, 500, 400]);
  });

  it("an OD account goes negative and stays exact; shown as −₹60,501", () => {
    const lines = [
      line("o1", "2026-10-01", 50_000, 0, -60_000),
      line("o2", "2026-10-02", 501, 0, -60_501),
      line("o3", "2026-10-03", 0, 20_000, -40_501),
    ];
    const r = runningBalances(lines, -10_000);
    expect(r.get("o2")?.balance).toBe(-60_501);
    expect(r.get("o3")?.balance).toBe(-40_501);
    expect(balanceText(-60_501)).toBe("−₹60,501");
    expect(balanceText(1_23_45_678)).toBe("₹1,23,45,678");
    expect(balanceText(0)).toBe("₹0");
  });

  it("a filtered subset keeps each row's true balance (computed over all lines)", () => {
    const lines = [
      line("x1", "2026-05-01", 0, 10_000),
      line("x2", "2026-05-02", 2_000, 0),
      line("int", "2026-05-03", 0, 37),
      line("x3", "2026-05-04", 1_000, 0),
    ];
    lines[2] = { ...lines[2], description: "INTEREST CREDIT" } as RunningLine;
    const all = runningBalances(lines, 0);
    const shown = applyBankFilters(
      lines.map((l) => ({ ...l, description: (l as { description?: string }).description ?? "NEFT", reference: null, matched_to_type: null })),
      { ...DEFAULT_FILTERS, q: "interest" },
    );
    expect(shown.map((l) => l.id)).toEqual(["int"]);
    expect(all.get("int")?.balance).toBe(8_037); // not 37 — the balance of the whole account at that line
  });

  it("flags a line whose statement balance differs by more than ₹1 (₹1 is paise rounding)", () => {
    const lines = [
      line("ok", "2026-06-01", 0, 1000, 1001),    // ₹1 off — rounding, no flag
      line("off", "2026-06-02", 0, 1000, 2500),   // statement says 2,500, app 2,000
      line("none", "2026-06-03", 100, 0, null),   // no statement balance — nothing to compare
    ];
    const r = runningBalances(lines, 0);
    expect(r.get("ok")?.statementSays).toBeNull();
    expect(r.get("off")?.statementSays).toBe(2500);
    expect(r.get("none")?.statementSays).toBeNull();
  });

  it("the list's newest / oldest sort uses the same same-day order (ctx.order)", () => {
    const lines = [
      line("a-first-day", "2026-04-01", 0, 100_000, 100_000),
      line("zz", "2026-04-02", 30_000, 0, 70_000),
      line("mm", "2026-04-02", 5_000, 0, 115_000),
      line("aa", "2026-04-02", 0, 50_000, 120_000),
    ].map((l) => ({ ...l, description: "x", reference: null, matched_to_type: null }));
    const r = runningBalances(lines, 0);
    const order = new Map([...r].map(([id, v]) => [id, v.seq]));
    expect(applyBankFilters(lines, DEFAULT_FILTERS, { order }).map((l) => l.id)).toEqual(["mm", "aa", "zz", "a-first-day"]);
    expect(applyBankFilters(lines, { ...DEFAULT_FILTERS, sort: "oldest" }, { order }).map((l) => l.id)).toEqual(["a-first-day", "zz", "aa", "mm"]);
  });
});
