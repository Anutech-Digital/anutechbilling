/* R-2497 — "Import + opening balance" is ONE database call (import_bank_statement_with_opening),
   so a refused opening leaves no line behind (CLAUDE.md §17b); with every line already in, only
   the checked opening RPC runs. Without the tick, the import is the plain R-1623 call. */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
import { importBankTransactions } from "./bank";

type Row = Record<string, unknown>;
function fakeClient(existing: Row[]) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const n = Array.isArray(args.p_rows) ? args.p_rows.length : 0;
      return { data: { batch_id: "batch-1", inserted: n }, error: null };
    },
    from() {
      let from = 0, to = Infinity;
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) b[m] = () => b;
      b.range = (f: number, t: number) => { from = f; to = t; return b; };
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: existing.slice(from, Math.min(to + 1, existing.length)), error: null }).then(res);
      return b;
    },
  };
  return { client: client as unknown as Parameters<typeof importBankTransactions>[0], calls };
}

const line = (d: string, credit: number, bal: number) =>
  ({ txn_date: d, description: `NEFT IN ${d}`, debit: 0, credit, balance_after: bal, reference: null });

describe("importBankTransactions with the opening (R-2497)", () => {
  it("lines + opening → one import_bank_statement_with_opening call", async () => {
    const { client, calls } = fakeClient([]);
    const out = await importBankTransactions(client, {
      accountId: "acc-1", rows: [line("2025-04-15", 80000, 150000)], fileName: "fy.csv", source: "csv",
      opening: { amount: 70000, date: "2025-04-01", acceptDifference: false },
    });
    expect(out).toEqual({ inserted: 1, duplicates: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("import_bank_statement_with_opening");
    expect(calls[0].args).toMatchObject({
      p_account_id: "acc-1", p_file_name: "fy.csv", p_source: "csv",
      p_opening: 70000, p_date: "2025-04-01", p_accept_difference: false,
    });
  });

  it("every line already in → only set_bank_opening_from_statement", async () => {
    const l = line("2025-04-15", 80000, 150000);
    const { client, calls } = fakeClient([{ ...l, id: "x" }]);
    const out = await importBankTransactions(client, {
      accountId: "acc-1", rows: [l], opening: { amount: 70000, date: "2025-04-01", acceptDifference: true },
    });
    expect(out).toEqual({ inserted: 0, duplicates: 1 });
    expect(calls.map((c) => c.name)).toEqual(["set_bank_opening_from_statement"]);
    expect(calls[0].args).toMatchObject({ p_opening: 70000, p_date: "2025-04-01", p_import_batch_id: null, p_accept_difference: true });
  });

  it("no tick → the plain import, no opening call", async () => {
    const { client, calls } = fakeClient([]);
    await importBankTransactions(client, { accountId: "acc-1", rows: [line("2025-04-15", 80000, 150000)] });
    expect(calls.map((c) => c.name)).toEqual(["import_bank_statement"]);
  });
});
