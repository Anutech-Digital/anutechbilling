/**
 * R-1921: the vendor statement's fold — order and running balance only; the amounts come from
 * vendor_statement() (its SQL test proves they add up to the popup's net and the Balance Sheet).
 * Rows below are the R-1906 owner cases as the database returns them.
 */
import { describe, it, expect } from "vitest";
import { foldStatement, closingWords, payablesTotals, toAgeingRow, toStatementRow, type VendorStatementRow } from "./vendor-statement";

const row = (p: Partial<VendorStatementRow> & Pick<VendorStatementRow, "entry_date" | "kind" | "amount">): VendorStatementRow => ({
  seq: { bill: 1, tds: 2, set_off: 3, payment: 4, advance: 5, advance_closed: 6, adjustment: 9 }[p.kind] ?? 4,
  doc_id: null, doc_ref: null, particulars: p.kind, set_off: 0, bank_txn_id: null, bank_account_id: null, ...p,
});

describe("foldStatement (R-1921)", () => {
  it("Verma: advance first, bill later, set-off moves nothing — closes at the bill's rest", () => {
    const s = foldStatement([
      row({ entry_date: "2026-10-06", kind: "bill", amount: 50000, doc_ref: "VC-1" }),
      row({ entry_date: "2026-09-26", kind: "advance", amount: -30000, bank_txn_id: "t1", bank_account_id: "a1" }),
      row({ entry_date: "2026-10-11", kind: "set_off", amount: 0, set_off: 30000 }),
    ]);
    expect(s.lines.map((l) => [l.date, l.kind, l.balance])).toEqual([
      ["2026-09-26", "advance", -30000],
      ["2026-10-06", "bill", 20000],
      ["2026-10-11", "set_off", 20000],
    ]);
    expect(s.closing).toBe(20000);
    expect(s.lines[2].setOff).toBe(30000);
    expect(s.lines[0].href).toBe("/accounting/banking/a1?focus=t1");
    expect(closingWords(s.closing)).toBe("You owe");
  });

  it("Kapoor: same day bill → TDS → payment, whatever order the rows arrive in", () => {
    const s = foldStatement([
      row({ entry_date: "2026-10-18", kind: "payment", amount: -9000 }),
      row({ entry_date: "2026-10-18", kind: "tds", amount: -1000 }),
      row({ entry_date: "2026-10-18", kind: "bill", amount: 10000 }),
    ]);
    expect(s.lines.map((l) => l.kind)).toEqual(["bill", "tds", "payment"]);
    expect(s.lines.map((l) => l.balance)).toEqual([10000, 9000, 0]);
    expect([s.billed, s.paid, s.closing]).toEqual([10000, 10000, 0]);
    expect(closingWords(0)).toBe("All settled");
  });

  it("a fresh advance with no bill yet: the vendor holds our money", () => {
    const s = foldStatement([row({ entry_date: "2026-10-23", kind: "advance", amount: -4000 })]);
    expect(s.closing).toBe(-4000);
    expect(closingWords(s.closing)).toBe("Advance with vendor");
  });

  it("counts adjustment rows so the screen can say a difference exists", () => {
    const s = foldStatement([
      row({ entry_date: "2026-07-23", kind: "bill", amount: 11800 }),
      row({ entry_date: "2026-10-26", kind: "adjustment", amount: -500 }),
    ]);
    expect(s.adjustments).toBe(1);
    expect(s.closing).toBe(11300);
  });

  it("database strings (bigint) become numbers", () => {
    const r = toStatementRow({ entry_date: "2026-10-01", seq: 1, kind: "bill", amount: "59000", set_off: "0", particulars: "Bill PS-1" });
    expect(r.amount).toBe(59000);
    expect(foldStatement([r]).closing).toBe(59000);
  });
});

describe("payablesTotals (R-1921)", () => {
  it("adds the buckets, the advance and the net across vendors", () => {
    const t = payablesTotals([
      toAgeingRow({ vendor_id: "v1", vendor_name: "Sharma", d31_60: "34000", total: "34000", net: "34000" }),
      toAgeingRow({ vendor_id: "v2", vendor_name: "Verma", d1_30: 20000, total: 20000, advance: 4000, net: 16000 }),
    ]);
    expect(t).toEqual({ not_due: 0, d1_30: 20000, d31_60: 34000, d61_90: 0, d90_plus: 0, total: 54000, advance: 4000, net: 50000 });
  });
});
