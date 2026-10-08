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

const MAX_ROWS = 1000;
type Row = Record<string, unknown>;

/** A minimal PostgREST stand-in: from/select/lt/gte/lte/order/range, awaited like supabase-js. */
function fakeClient(tables: Record<string, Row[]>) {
  const calls: { table: string; ranged: boolean }[] = [];
  const client = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const orders: string[] = [];
      let range: [number, number] | null = null;
      const b = {
        select: () => b,
        lt: (c: string, v: string) => { rows = rows.filter((r) => String(r[c]) < v); return b; },
        gte: (c: string, v: string) => { rows = rows.filter((r) => String(r[c]) >= v); return b; },
        lte: (c: string, v: string) => { rows = rows.filter((r) => String(r[c]) <= v); return b; },
        order: (c: string) => { orders.push(c); return b; },
        range: (from: number, to: number) => { range = [from, to]; return b; },
        then<T>(ok: (v: { data: Row[]; error: null }) => T) {
          calls.push({ table, ranged: range !== null });
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
