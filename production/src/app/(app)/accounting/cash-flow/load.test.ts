/**
 * R-265 — Cash Flow must not stop at 1000 bank lines.
 *
 * The fake client behaves like PostgREST: it answers at most 1000 rows (max_rows) and says
 * nothing when it cut the answer short. With more than 1000 lines before the range, the old
 * bare select summed only the first 1000, so the opening balance — and every month's closing —
 * was wrong. The closing must equal what bank_account_current_balance() gives: opening balance
 * of every account + every credit − every debit.
 */
import { describe, it, expect } from "vitest";
import { loadCashFlow } from "./load";
import { monthRows } from "@/lib/accounting/cash-flow-summary";
import { cashFlowByActivity } from "@/lib/accounting/cash-flow-lines";

const MAX_ROWS = 1000;
type Row = Record<string, unknown>;

/** A minimal PostgREST stand-in: from/select/eq/not-is-null/lt/gte/lte/order/range, awaited like
 *  supabase-js. A table named in `failing` answers with an error (RLS / network). */
function fakeClient(tables: Record<string, Row[]>, failing: readonly string[] = []) {
  const calls: { table: string; ranged: boolean }[] = [];
  const client = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const orders: string[] = [];
      let range: [number, number] | null = null;
      const b = {
        select: () => b,
        eq: (c: string, v: string) => { rows = rows.filter((r) => r[c] === v); return b; },
        not: (c: string, op: string, v: null) => {
          if (op !== "is" || v !== null) throw new Error(`fake client: not(${op}) unsupported`);
          rows = rows.filter((r) => r[c] != null); return b;
        },
        lt: (c: string, v: string) => { rows = rows.filter((r) => String(r[c]) < v); return b; },
        gte: (c: string, v: string) => { rows = rows.filter((r) => String(r[c]) >= v); return b; },
        lte: (c: string, v: string) => { rows = rows.filter((r) => String(r[c]) <= v); return b; },
        order: (c: string) => { orders.push(c); return b; },
        range: (from: number, to: number) => { range = [from, to]; return b; },
        then<T>(ok: (v: { data: Row[] | null; error: { message: string } | null }) => T) {
          calls.push({ table, ranged: range !== null });
          if (failing.includes(table)) return Promise.resolve({ data: null, error: { message: `permission denied for ${table}` } }).then(ok);
          const sorted = orders.length
            ? [...rows].sort((x, y) => {
                for (const c of orders) {
                  const a = String(x[c]), z = String(y[c]);
                  if (a !== z) return a < z ? -1 : 1;
                }
                return 0;
              })
            : rows;
          const [s, e] = range ?? [0, sorted.length - 1];
          const page = sorted.slice(s, Math.min(e + 1, s + MAX_ROWS));   // server cap
          return Promise.resolve({ data: page, error: null }).then(ok);
        },
      };
      return b;
    },
  };
  return { client: client as unknown as Parameters<typeof loadCashFlow>[0], calls };
}

const pad = (n: number, w = 5) => String(n).padStart(w, "0");
function txns(n: number, startDay: string, idPrefix: string, credit: number, debit: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${idPrefix}-${pad(i)}`,
    bank_account_id: "acct-1",
    txn_date: startDay,
    description: null,
    credit: i % 2 === 0 ? credit : 0,
    debit: i % 2 === 1 ? debit : 0,
    matched_to_type: null,
    category: null,
  }));
}

/** What bank_account_current_balance() sums, summed over every account. */
function bankBalance(tables: Record<string, Row[]>): number {
  const open = (tables.bank_accounts ?? []).reduce((s, a) => s + Number(a.opening_balance ?? 0), 0);
  return open + (tables.bank_transactions ?? []).reduce(
    (s, t) => s + Number(t.credit ?? 0) - Number(t.debit ?? 0), 0);
}

const closing = (d: { lines: Parameters<typeof monthRows>[0]; balanceBefore: number }) => {
  const rows = monthRows(d.lines, d.balanceBefore);
  return rows[rows.length - 1].balanceEnd;
};

describe("Cash Flow reads every bank line (R-265)", () => {
  it("small data: same figure as before — opening + lines = bank balance", async () => {
    const tables = {
      bank_accounts: [{ id: "acct-1", opening_balance: 50_000 }],
      bank_transactions: [
        ...txns(10, "2026-01-15", "old", 3_000, 1_000),
        ...txns(6, "2026-06-10", "new", 2_000, 500),
      ],
    };
    const { client } = fakeClient(tables);
    const d = await loadCashFlow(client, "2026-04-01", "2026-10-07");
    expect(d.balanceBefore).toBe(50_000 + 5 * 3_000 - 5 * 1_000);
    expect(d.lines).toHaveLength(6);
    expect(closing(d)).toBe(bankBalance(tables));
  });

  it("past 1000 lines before the range: opening is the full sum, closing = bank balance", async () => {
    const tables = {
      bank_accounts: [{ id: "acct-1", opening_balance: 10_000 }, { id: "acct-2", opening_balance: 2_500 }],
      bank_transactions: [
        ...txns(2_501, "2025-12-31", "old", 700, 300),   // 3 pages before the range
        ...txns(1_203, "2026-05-02", "new", 400, 900),   // 2 pages inside it
      ],
    };
    const { client, calls } = fakeClient(tables);
    const d = await loadCashFlow(client, "2026-04-01", "2026-10-07");
    expect(d.balanceBefore).toBe(12_500 + 1_251 * 700 - 1_250 * 300);
    expect(d.lines).toHaveLength(1_203);
    expect(new Set(d.lines.map((l) => l.id)).size).toBe(1_203);
    expect(closing(d)).toBe(bankBalance(tables));
    expect(calls.every((c) => c.ranged)).toBe(true);
  });

  it("all time (no from): every line in range, closing = bank balance", async () => {
    const tables = {
      bank_accounts: [{ id: "acct-1", opening_balance: 1_000 }],
      bank_transactions: txns(1_500, "2026-02-01", "t", 100, 40),
    };
    const { client } = fakeClient(tables);
    const d = await loadCashFlow(client, null, null);
    expect(d.balanceBefore).toBe(1_000);
    expect(d.lines).toHaveLength(1_500);
    expect(closing(d)).toBe(bankBalance(tables));
  });
});

describe("Cash Flow respects each account's opening date (R-2497)", () => {
  it("lines before the opening date are inside the opening: not in the start balance, not in the months", async () => {
    // Opening 1,00,000 as of 1 Apr 2026; the FY 25-26 statement (+30,000 net) was imported without moving it.
    const tables = {
      bank_accounts: [{ id: "acct-1", opening_balance: 100_000, opening_balance_date: "2026-04-01" }],
      bank_transactions: [
        ...txns(2, "2025-06-10", "fy25", 40_000, 10_000),   // +40,000 −10,000, before the opening
        ...txns(2, "2026-03-20", "mar", 5_000, 5_000),      // in range, still before the opening
        ...txns(2, "2026-05-02", "fy26", 20_000, 5_000),    // counted
      ],
    };
    const { client } = fakeClient(tables);
    const d = await loadCashFlow(client, "2026-03-01", "2026-10-07");
    expect(d.balanceBefore).toBe(100_000);
    expect(d.lines.map((l) => l.id).sort()).toEqual(["fy26-00000", "fy26-00001"]);
    expect(closing(d)).toBe(115_000);   // = bank_account_current_balance after R-2497
  });
});

describe("Cash Flow knows which bank lines are money LENT (R-2575)", () => {
  const line = (id: string, matched_to_type: string | null, debit: number, credit: number): Row => ({
    id, bank_account_id: "acct-1", txn_date: "2026-05-02", description: null, debit, credit, matched_to_type, category: null,
  });
  const tables = {
    bank_accounts: [{ id: "acct-1", opening_balance: 0 }],
    bank_transactions: [
      line("adv-given", "bs_item", 50_000, 0),      // book_bank_advance 'given' → asset row
      line("dir-loan", "bs_item", 0, 200_000),      // book_bank_credit director loan → liability row
      line("capital", "bs_item", 0, 100_000),       // owner capital → equity row
      line("old-adv", "manual", 7_000, 0),          // before R-2570: hand-marked, asset row
      line("old-loan", "manual", 20_000, 0),        // before R-2570: Give loan payout stored 'manual'
      line("old-back", "manual", 0, 5_000),         // before R-2570: borrower's repayment stored 'manual'
      line("new-loan", "loan_given", 30_000, 0),
      line("sale", "payment", 0, 900),
    ],
    balance_sheet_items: [
      { id: "b1", bank_txn_id: "adv-given", section: "asset" },
      { id: "b2", bank_txn_id: "dir-loan", section: "liability" },
      { id: "b3", bank_txn_id: "capital", section: "equity" },
      { id: "b4", bank_txn_id: "old-adv", section: "asset" },
      { id: "b5", bank_txn_id: null, section: "asset" },
    ],
    loans_given: [{ id: "g1", bank_txn_id: "old-loan" }, { id: "g2", bank_txn_id: "new-loan" }, { id: "g3", bank_txn_id: null }],
    loan_repayments: [{ id: "r1", bank_txn_id: "old-back" }],
  };

  it("an asset balance-sheet row, a Loans given payout or a repayment marks the line lent — keyed by bank_txn_id, so old 'manual' lines too", async () => {
    const { client } = fakeClient(tables);
    const d = await loadCashFlow(client, "2026-04-01", "2026-10-07");
    const lent = Object.fromEntries(d.lines.map((l) => [l.id, l.lent]));
    expect(lent).toEqual({
      "adv-given": true, "dir-loan": false, capital: false, "old-adv": true,
      "old-loan": true, "old-back": true, "new-loan": true, sale: false,
    });
    const f = cashFlowByActivity(d.lines);
    expect(Object.fromEntries(f.map((g) => [g.activity, g.net]))).toEqual({
      operating: 900, investing: -(50_000 + 7_000 + 20_000 + 30_000) + 5_000, financing: 300_000,
    });
  });

  it("a failed read of those bookings never fails the page — those lines stay in Financing, as before", async () => {
    const { client } = fakeClient(tables, ["balance_sheet_items", "loans_given", "loan_repayments"]);
    const d = await loadCashFlow(client, "2026-04-01", "2026-10-07");
    expect(d.lines).toHaveLength(8);
    expect(d.lines.every((l) => l.lent === false)).toBe(true);
    const f = cashFlowByActivity(d.lines);
    expect(Object.fromEntries(f.map((g) => [g.activity, g.net]))).toEqual({
      operating: 900, investing: -30_000, financing: 300_000 - 50_000 - 7_000 - 20_000 + 5_000,
    });
  });
});
