/* R-2894 — Hitesh (16 Nov): two employees (or two months of one) with the same net salary, paid on
   different days. "Link now" offered only the FIRST unlinked line of that amount. Now every
   unlinked line of the amount is offered, the one nearest the salary's pay date first. */
import { describe, expect, it } from "vitest";
import {
  groupWaitingBankLines, candidateBankLines, salaryRefDate, bankLineFocusHref, type WaitingBankLine,
} from "./salary-bank-link";

const T = "tenant-a";
const row = (o: Partial<WaitingBankLine> & { id: string }) => ({
  bank_account_id: "acct-1", txn_date: "2026-10-03", description: "NEFT-SALARY", debit: 52000, tenant_id: T,
  matched_to_type: null as string | null, ...o,
});

describe("groupWaitingBankLines", () => {
  it("two same-amount lines on different days are BOTH kept under that amount", () => {
    const m = groupWaitingBankLines([
      row({ id: "l-oct", txn_date: "2026-10-03" }),
      row({ id: "l-jun", txn_date: "2026-07-02" }),
    ], T, new Set());
    expect(m.get(52000)?.map((l) => l.id)).toEqual(["l-jun", "l-oct"]);
  });

  it("a line that is already linked (matched, or a salary's reconciled line) is never offered", () => {
    const m = groupWaitingBankLines([
      row({ id: "l-matched", matched_to_type: "salary" }),
      row({ id: "l-recon" }),
      row({ id: "l-free", txn_date: "2026-08-01" }),
    ], T, new Set(["l-recon"]));
    expect(m.get(52000)?.map((l) => l.id)).toEqual(["l-free"]);
  });

  it("another tenant's line is never offered", () => {
    const m = groupWaitingBankLines([row({ id: "l-other", tenant_id: "tenant-b" }), row({ id: "l-mine" })], T, new Set());
    expect(m.get(52000)?.map((l) => l.id)).toEqual(["l-mine"]);
  });

  it("keeps the narration + bank account, rounds the amount key, drops credits and duplicates", () => {
    const m = groupWaitingBankLines([
      row({ id: "a", debit: 51999.6, bank_account_id: "acct-2", description: "UTR 123" }),
      row({ id: "a", debit: 51999.6 }),
      row({ id: "c", debit: 0 }),
    ], T, new Set());
    expect(m.get(52000)).toEqual([expect.objectContaining({ id: "a", bank_account_id: "acct-2", description: "UTR 123" })]);
    expect(m.size).toBe(1);
  });
});

describe("candidateBankLines — nearest the salary's pay date first", () => {
  const lines: WaitingBankLine[] = [
    { id: "oct", bank_account_id: "a", txn_date: "2026-10-03", description: null, debit: 52000 },
    { id: "jul", bank_account_id: "a", txn_date: "2026-07-02", description: null, debit: 52000 },
    { id: "aug", bank_account_id: "a", txn_date: "2026-08-04", description: null, debit: 52000 },
  ];
  it("June salary paid 2 Jul → the 2 Jul line is first, then 4 Aug, then 3 Oct", () => {
    expect(candidateBankLines(lines, "2026-07-02").map((l) => l.id)).toEqual(["jul", "aug", "oct"]);
  });
  it("Sep salary paid 30 Sep → 3 Oct first", () => {
    expect(candidateBankLines(lines, "2026-09-30")[0].id).toBe("oct");
  });
  it("equal distance → the earlier line first; none → empty list", () => {
    const tie: WaitingBankLine[] = [
      { id: "late", bank_account_id: "a", txn_date: "2026-07-12", description: null, debit: 1 },
      { id: "early", bank_account_id: "a", txn_date: "2026-07-08", description: null, debit: 1 },
    ];
    expect(candidateBankLines(tie, "2026-07-10").map((l) => l.id)).toEqual(["early", "late"]);
    expect(candidateBankLines(undefined, "2026-07-10")).toEqual([]);
  });
  it("does not change the input", () => {
    const copy = [...lines];
    candidateBankLines(lines, "2026-07-02");
    expect(lines).toEqual(copy);
  });
});

describe("salaryRefDate / bankLineFocusHref", () => {
  it("pay date when there is one, else the last day of the salary month", () => {
    expect(salaryRefDate({ period: "2026-06", pay_date: "2026-07-02" })).toBe("2026-07-02");
    expect(salaryRefDate({ period: "2026-06", pay_date: null })).toBe("2026-06-30");
    expect(salaryRefDate({ period: "2026-02" })).toBe("2026-02-28");
  });
  it("opens exactly that line's reconcile (focus), not 'the first line of this amount'", () => {
    expect(bankLineFocusHref({ id: "l-1", bank_account_id: "acct-9" })).toBe("/accounting/banking/acct-9?focus=l-1");
  });
});
