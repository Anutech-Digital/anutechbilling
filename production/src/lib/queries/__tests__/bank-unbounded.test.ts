/**
 * R-1509 — the bank account page and the statement import must see EVERY line, not the
 * first 1000.
 *
 * The data gateway answers at most 1000 rows a request (src/server/postgrest/build.ts
 * MAX_ROWS, and supabase/config.toml max_rows) and says nothing when it cut the answer
 * short. Staging, a tenant's bank account: "1000 txns not yet in books" (exactly
 * 1000), a Balance in bank lakhs off the statement, and "Lines missing" across May–Sep —
 * because the page summed the newest 1000 lines. Worse, the import's duplicate check asked
 * for `.limit(5000)`, got 1000, and would insert every older line of a re-uploaded
 * statement a second time.
 *
 * The fake client below behaves like the gateway: it honours .order() and .range(), and
 * caps every answer at 1000 rows whatever .limit() asked for.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: Object.assign(() => undefined, { success: () => undefined }) }));

import {
  fetchBankTransactions,
  fetchExistingTxnKeys,
  importBankTransactions,
  type BankTransactionRow,
} from "../bank";
import { checkStatement } from "@/lib/banking/statement-check";

const GATEWAY_MAX_ROWS = 1000;
type Row = Record<string, unknown>;

/** A fake PostgREST that caps like the real gateway. */
function gatewayClient(tables: Record<string, Row[]>) {
  const inserted: Row[] = [];
  let requests = 0;
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from(table: string) {
      requests++;
      const filters: [string, string, unknown][] = [];
      const orders: [string, boolean][] = [];
      let limit: number | undefined;
      let offset = 0;
      let single = false;
      let insertRows: Row[] | null = null;
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { filters.push(["eq", c, v]); return b; };
      b.is = (c: string, v: unknown) => { filters.push(["is", c, v]); return b; };
      b.order = (c: string, o?: { ascending?: boolean }) => { orders.push([c, o?.ascending !== false]); return b; };
      b.limit = (n: number) => { limit = n; return b; };
      b.range = (from: number, to: number) => { offset = from; limit = to - from + 1; return b; };
      b.single = () => { single = true; return b; };
      b.insert = (rows: Row[]) => { insertRows = rows; return b; };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (insertRows) {
          const withIds = insertRows.map((r, i) => ({ ...r, id: `new-${inserted.length + i}` }));
          inserted.push(...withIds);
          (tables[table] ??= []).push(...withIds);
          return Promise.resolve({ data: withIds.map((r) => ({ id: r.id })), error: null }).then(res, rej);
        }
        let rows = (tables[table] ?? []).filter((r) => filters.every(([op, c, v]) =>
          op === "eq" ? r[c] === v : (r[c] ?? null) === v));
        if (orders.length) {
          rows = [...rows].sort((a, z) => {
            for (const [c, asc] of orders) {
              const x = String(a[c]), y = String(z[c]);
              if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
            }
            return 0;
          });
        }
        const cap = Math.min(limit ?? GATEWAY_MAX_ROWS, GATEWAY_MAX_ROWS);
        const page = rows.slice(offset, offset + cap);
        return Promise.resolve({ data: single ? page[0] ?? null : page, error: null }).then(res, rej);
      };
      return b;
    },
  };
  return { client: client as never, inserted, requests: () => requests };
}

/** `n` statement lines of one account, a running balance that agrees with every line. */
function statement(n: number, opening = 100_000): BankTransactionRow[] {
  const out: BankTransactionRow[] = [];
  let bal = opening;
  const start = Date.UTC(2026, 3, 1);
  for (let i = 0; i < n; i++) {
    const credit = i % 3 === 0 ? 5_000 + i : 0;
    const debit = credit ? 0 : 1_000 + (i % 50);
    bal += credit - debit;
    out.push({
      id: `t${String(i).padStart(5, "0")}`,
      tenant_id: "ten1",
      bank_account_id: "acc1",
      txn_date: new Date(start + Math.floor(i / 8) * 86_400_000).toISOString().slice(0, 10),
      description: `UTR${String(i).padStart(6, "0")}-NEFT-PARTY`,
      debit,
      credit,
      balance_after: bal,
      reference: null,
      source: "csv_upload",
      matched_to_type: null,
      matched_to_id: null,
      matched_at: null,
      matched_by: null,
      match_confidence: null,
      imported_at: "2026-10-01T00:00:00Z",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
  }
  return out;
}

const OPENING = 100_000;

describe("bank account page reads every line (R-1509)", () => {
  it("1500 lines in the account → 1500 lines on the page, not 1000", async () => {
    const lines = statement(1500, OPENING);
    const { client } = gatewayClient({ bank_transactions: [...lines] });
    const got = await fetchBankTransactions(client, "acc1");
    expect(got).toHaveLength(1500);
    expect(new Set(got.map((t) => t.id)).size).toBe(1500);   // no line read twice
    // Newest first, as the page always showed them.
    expect(got[0].txn_date >= got[got.length - 1].txn_date).toBe(true);
  });

  it("only this account's lines", async () => {
    const other = statement(1200).map((t) => ({ ...t, id: `o${t.id}`, bank_account_id: "acc2" }));
    const { client } = gatewayClient({ bank_transactions: [...statement(1100), ...other] });
    const got = await fetchBankTransactions(client, "acc1");
    expect(got).toHaveLength(1100);
    expect(got.every((t) => t.bank_account_id === "acc1")).toBe(true);
  });

  it("the statement check agrees with the bank when every line is read — no made-up 'lines missing'", async () => {
    const lines = statement(1500, OPENING);
    const { client } = gatewayClient({ bank_transactions: [...lines] });
    const got = await fetchBankTransactions(client, "acc1");
    const unmatched = got.filter((t) => t.matched_to_type === null).length;
    expect(unmatched).toBe(1500);   // the page's "N txns not yet in books"
    const check = checkStatement(got, OPENING)!;
    expect(check.gaps).toEqual([]);
    expect(check.openingDifference).toBe(0);
    expect(check.difference).toBe(0);
    expect(check.statementBalance).toBe(lines[lines.length - 1].balance_after);
  });
});

describe("statement import never duplicates past the 1000th existing line (R-1509)", () => {
  it("existing keys cover all 1500 lines", async () => {
    const lines = statement(1500);
    const { client } = gatewayClient({ bank_transactions: [...lines] });
    const keys = await fetchExistingTxnKeys(client, "acc1");
    // every line carries a running balance, so every line has its balance key (R-1691 index)
    expect(keys.bal.size).toBe(1500);
  });

  it("re-importing the same 1500-line statement inserts 0 lines", async () => {
    const lines = statement(1500);
    const { client, inserted } = gatewayClient({
      bank_transactions: [...lines],
      users: [{ id: "u1", tenant_id: "ten1" }],
    });
    const rows = lines.map(({ txn_date, description, debit, credit, balance_after, reference }) =>
      ({ txn_date, description, debit, credit, balance_after, reference }));
    const res = await importBankTransactions(client, { accountId: "acc1", rows });
    expect(inserted).toHaveLength(0);
    expect(res).toEqual({ inserted: 0, duplicates: 1500 });
  });

  it("an overlapping statement inserts only the new lines", async () => {
    const all = statement(1700);
    const { client, inserted } = gatewayClient({
      bank_transactions: all.slice(0, 1500),
      users: [{ id: "u1", tenant_id: "ten1" }],
    });
    const rows = all.slice(200).map(({ txn_date, description, debit, credit, balance_after, reference }) =>
      ({ txn_date, description, debit, credit, balance_after, reference }));
    const res = await importBankTransactions(client, { accountId: "acc1", rows });
    expect(res).toEqual({ inserted: 200, duplicates: 1300 });
    expect(inserted.map((r) => r.description)).toEqual(all.slice(1500).map((t) => t.description));
    expect(inserted.every((r) => r.bank_account_id === "acc1" && r.tenant_id === "ten1" && r.source === "csv_upload")).toBe(true);
  });
});

/** Comments stripped: prose about a removed pattern must not satisfy a scan for it. */
const strip = (f: string) =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("no bank_transactions read in the banking code relies on .limit() past the cap (R-1509)", () => {
  it.each([
    "src/lib/queries/bank.ts",
    "src/app/(app)/accounting/banking/rules/page.tsx",
  ])("%s asks for no more than 1000 rows in one request", (file) => {
    for (const m of strip(file).matchAll(/\.limit\((\d+)\)/g)) {
      expect(Number(m[1]), `${file}: .limit(${m[1]}) — the gateway returns 1000 and says nothing`).toBeLessThanOrEqual(1000);
    }
  });

  it("every unbounded bank_transactions select in bank.ts pages with .range()", () => {
    const src = strip("src/lib/queries/bank.ts");
    let i = -1;
    while ((i = src.indexOf('.from("bank_transactions")', i + 1)) !== -1) {
      const stmt = src.slice(i, src.indexOf(";", i));
      if (!stmt.includes(".select(")) continue;                    // insert / update
      if (/\.eq\("id"|\.single\(|head: true|\.limit\(\d+\)/.test(stmt)) continue;   // one row / bounded
      if (stmt.includes(".insert(") || stmt.includes(".update(")) continue;
      expect(stmt, "a bank_transactions list read with no .range()").toContain(".range(");
      expect(stmt, "paged read needs a unique tie-break").toContain('.order("id"');
    }
  });
});
