import { describe, expect, it } from "vitest";
import { monthWindow, pairMonth, summarise, inLineWindow, type BatchRow } from "./settlement-batch";
import type { BankLine, RzpSettlement } from "./settlement-match";

const at = (day: string, hour = 10) => Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00+05:30`) / 1000;
const line = (id: string, day: string, credit: number, narration = "NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR"): BankLine =>
  ({ id, txn_date: day, credit, reference: null, description: narration });
const setl = (id: string, day: string, paise: number, utr: string | null = null): RzpSettlement =>
  ({ id, amount: paise, fees: 0, tax: 0, utr, created_at: at(day) });

describe("R-2654 pairMonth — UTR first, then the one settlement of that amount, fail closed", () => {
  it("pairs by UTR when the narration carries it, else by amount", () => {
    const lines = [line("L1", "2025-10-03", 2535, "NEFT CR-UTIB0001506-RAZORPAY PAYMENTS-AXISCN0123456789"), line("L2", "2025-10-10", 12642)];
    const s = [setl("setl_A", "2025-10-02", 253473, "AXISCN0123456789"), setl("setl_B", "2025-10-09", 1264200)];
    const out = pairMonth(lines, s);
    expect(out.map((p) => [p.line.id, p.settlement?.id, p.by, p.problem])).toEqual([
      ["L1", "setl_A", "utr", null],
      ["L2", "setl_B", "amount", null],
    ]);
  });

  it("paise: settlement ₹2,534.73 is the same money as a ₹2,535 line (R-2099 sameRupees)", () => {
    const out = pairMonth([line("L1", "2025-10-03", 2535)], [setl("setl_A", "2025-10-02", 253473)]);
    expect(out[0].settlement?.id).toBe("setl_A");
  });

  it("two lines one settlement: neither is paired, both say which other line", () => {
    const lines = [line("L1", "2025-10-03", 5000), line("L2", "2025-10-04", 5000)];
    const out = pairMonth(lines, [setl("setl_A", "2025-10-03", 500000)]);
    expect(out.every((p) => p.settlement === null)).toBe(true);
    expect(out[0].problem).toMatch(/setl_A .* could be this line or 2025-10-04 \(₹5,000\)/);
    expect(out[1].problem).toMatch(/could be this line or 2025-10-03/);
  });

  it("two settlements one line (no UTR): not paired, names both settlements", () => {
    const out = pairMonth([line("L1", "2025-10-05", 5000)], [setl("setl_A", "2025-10-03", 500000), setl("setl_B", "2025-10-05", 500000)]);
    expect(out[0].settlement).toBeNull();
    expect(out[0].problem).toMatch(/2 Razorpay settlements of ₹5,000 .*setl_A, setl_B.* no UTR/);
  });

  it("UTR decides between two settlements of the same amount", () => {
    const lines = [line("L1", "2025-10-05", 5000, "RAZORPAY UTRAAA111222")];
    const out = pairMonth(lines, [setl("setl_A", "2025-10-03", 500000, "UTRAAA111222"), setl("setl_B", "2025-10-05", 500000, "UTRBBB333444")]);
    expect(out[0]).toMatchObject({ by: "utr", problem: null });
    expect(out[0].settlement?.id).toBe("setl_A");
  });

  it("a settlement claimed by UTR is not offered to another line by amount", () => {
    const lines = [line("L1", "2025-10-05", 5000, "RAZORPAY UTRAAA111222"), line("L2", "2025-10-05", 5000)];
    const out = pairMonth(lines, [setl("setl_A", "2025-10-04", 500000, "UTRAAA111222")]);
    expect(out[0].settlement?.id).toBe("setl_A");
    expect(out[1].settlement).toBeNull();
    expect(out[1].problem).toMatch(/No Razorpay settlement of ₹5,000/);
  });

  it("UTR pair with a different amount stays paired — R-2099's plan then blocks it on the amount", () => {
    const out = pairMonth([line("L1", "2025-10-05", 4999, "RAZORPAY UTRAAA111222")], [setl("setl_A", "2025-10-04", 500000, "UTRAAA111222")]);
    expect(out[0]).toMatchObject({ by: "utr", problem: null });
  });

  it("a settlement already reconciled to another line is never offered", () => {
    const out = pairMonth([line("L1", "2025-10-05", 5000)], [setl("setl_A", "2025-10-04", 500000)], new Set(["setl_A"]));
    expect(out[0].settlement).toBeNull();
    const out2 = pairMonth([line("L1", "2025-10-05", 5000, "RAZORPAY UTRAAA111222")], [setl("setl_A", "2025-10-04", 500000, "UTRAAA111222")], new Set(["setl_A"]));
    expect(out2[0].problem).toMatch(/already reconciled to another bank line/);
  });

  it("window: 4 days before to 1 day after the line (IST)", () => {
    expect(inLineWindow("2025-10-10", setl("s", "2025-10-06", 1))).toBe(true);
    expect(inLineWindow("2025-10-10", { ...setl("s", "2025-10-06", 1), created_at: at("2025-10-05", 23) })).toBe(false);
    expect(inLineWindow("2025-10-10", { ...setl("s", "2025-10-11", 1), created_at: at("2025-10-11", 23) })).toBe(true);
    expect(inLineWindow("2025-10-10", { ...setl("s", "2025-10-12", 1), created_at: at("2025-10-12", 0) })).toBe(false);
    const out = pairMonth([line("L1", "2025-10-10", 5000)], [setl("setl_far", "2025-10-01", 500000)]);
    expect(out[0].settlement).toBeNull();
  });
});

describe("R-2654 monthWindow + summarise", () => {
  it("covers the month's lines' windows", () => {
    const w = monthWindow("2026-02");
    expect(w.first).toBe("2026-02-01");
    expect(w.last).toBe("2026-02-28");
    expect(w.from).toBe(Date.parse("2026-01-28T00:00:00+05:30") / 1000);
    expect(w.to).toBe(Date.parse("2026-03-02T00:00:00+05:30") / 1000 - 1);
  });
  it("counts ready / blocked and the ready money", () => {
    const row = (ready: boolean, amount: number): BatchRow => ({ txnId: String(amount), txnDate: "2025-10-01", amount, narration: "", settlementId: null, utr: null, pairedBy: null, ready, blockers: [], payments: 0, gross: 0, fee: 0, feeGst: 0 });
    expect(summarise("2025-10", [row(true, 100), row(false, 50), row(true, 25)])).toMatchObject({ ready: 2, blocked: 1, readyAmount: 125 });
  });
});
