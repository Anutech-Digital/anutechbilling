/* R-2528 — the statement line's printed paise reach the database (import_bank_statement stores
   net_paise / balance_after_paise), so the opening move compares the statement in paise. A line
   without paise sends none (the database then reads whole rupees × 100). */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
import { importBankTransactions } from "./bank";
import { parseStatement } from "@/lib/banking/statement-parse";
import { SUBHVISION_CSV } from "@/lib/banking/opening-move-r2522.fixture";

function fakeClient() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: { batch_id: "batch-1", inserted: 5 }, error: null };
    },
    from() {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "range"]) b[m] = () => b;
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
      return b;
    },
  };
  return { client: client as unknown as Parameters<typeof importBankTransactions>[0], calls };
}

describe("importBankTransactions sends the printed paise (R-2528)", () => {
  it("SUBHVISION: paise lines carry amount_paise / balance_paise; a whole-rupee amount sends none", async () => {
    const { client, calls } = fakeClient();
    await importBankTransactions(client, {
      accountId: "acc-1", rows: parseStatement(SUBHVISION_CSV).rows, fileName: "fy.csv", source: "csv",
      opening: { amount: 2020919, date: "2025-04-01", acceptDifference: false },
    });
    const rows = calls[0].args.p_rows as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ debit: 500001, amount_paise: 50000050, balance_after: 1520918, balance_paise: 152091846 });
    expect(rows[4]).toMatchObject({ credit: 37170, balance_paise: 90355193, value_date: "2026-03-31" });
    expect(rows[4]).not.toHaveProperty("amount_paise");
  });
});
