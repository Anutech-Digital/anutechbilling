import { describe, it, expect, vi } from "vitest";

// bank.ts imports the browser Supabase client at module load; the key helpers need none of it.
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
import { bankTxnKey, bankTxnBalanceKey, indexBankLines, splitNewBankLines, importBankTransactions, fetchExistingTxnKeys, planBankImport } from "./bank";

type Line = Parameters<typeof indexBankLines>[0][number];
const isDup = (a: Line, known: Line[]) => splitNewBankLines([a], indexBankLines(known)).duplicates === 1;

describe("splitNewBankLines — the same line read twice is one line", () => {
  const csvLine = { txn_date: "2026-05-02", debit: 18999, credit: 0, description: "NEFT DR-FINO0001157-PRASHANT BHAIYA-NETBANK", balance_after: 262245 };

  it("CSV line vs the AI's differently-worded reading of it: duplicate by running balance", () => {
    const aiLine = { ...csvLine, description: "NEFT DR FINO PRASHANT BHAIYA" };
    expect(bankTxnKey(aiLine)).not.toBe(bankTxnKey(csvLine));   // the old key missed it
    expect(isDup(aiLine, [csvLine])).toBe(true);
  });

  it("two genuinely different lines with the same date and amount stay separate", () => {
    const other = { ...csvLine, description: "NEFT DR-HDFC0002222-SOMEONE ELSE", balance_after: 243246 };
    expect(isDup(other, [csvLine])).toBe(false);
  });

  it("without a running balance it falls back to the description key only", () => {
    const noBal = { txn_date: "2026-05-02", debit: 18999, credit: 0, description: "SOMETHING ELSE", balance_after: null };
    expect(bankTxnBalanceKey(noBal)).toBeNull();
    expect(isDup(noBal, [csvLine])).toBe(false);
  });
});

/* ─── R-1691 — a line with a running balance is a duplicate only on date + amount + balance ───
   Two REAL ₹500 credits on one day whose narrations share the first 25 characters
   ("UPI-RAZORPAY SOFTWARE PRIVA…") were one line to the old rule, so the second never
   reached the books. Their running balances differ — the statement itself says they are two. */

type Row = Record<string, unknown>;
/** Just enough of a Supabase client for importBankTransactions: existing lines in, inserted rows out. */
function fakeClient(existing: Row[]) {
  const inserted: Row[] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    /* R-1623: an import is one import_bank_statement call — the batch and its lines together. */
    rpc: async (name: string, args: { p_rows: Row[] }) => {
      if (name !== "import_bank_statement") throw new Error(`unexpected rpc ${name}`);
      inserted.push(...args.p_rows);
      return { data: { batch_id: "batch-1", inserted: args.p_rows.length }, error: null };
    },
    from(table: string) {
      let insertRows: Row[] | null = null;
      let from = 0, to = Infinity;
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) b[m] = () => b;
      b.range = (f: number, t: number) => { from = f; to = t; return b; };
      b.single = () => b;
      b.insert = (rows: Row[]) => { insertRows = rows; return b; };
      b.then = (res: (v: unknown) => unknown) => {
        if (insertRows) {
          inserted.push(...insertRows);
          return Promise.resolve({ data: insertRows.map((_, i) => ({ id: `n${i}` })), error: null }).then(res);
        }
        if (table === "users") return Promise.resolve({ data: { tenant_id: "t1" }, error: null }).then(res);
        return Promise.resolve({ data: existing.slice(from, to + 1), error: null }).then(res);
      };
      return b;
    },
  };
  return { client: client as never, inserted };
}

const rzp = (credit: number, balance_after: number | null, tail = "") => ({
  txn_date: "2026-06-12", debit: 0, credit,
  description: `UPI-RAZORPAY SOFTWARE PRIVATE LIMITED-${tail}`, balance_after, reference: null as string | null,
});

describe("R-1691 — same day, same amount, same narration prefix", () => {
  const statement = [rzp(500, 10500, "RZP111"), rzp(500, 11000, "RZP222")];

  it("two real lines with different running balances are both inserted", async () => {
    const { client, inserted } = fakeClient([]);
    const res = await importBankTransactions(client, { accountId: "a1", rows: statement });
    expect(res).toEqual({ inserted: 2, duplicates: 0 });
    expect(inserted.map((r) => r.balance_after)).toEqual([10500, 11000]);
  });

  it("re-uploading the same statement skips both", async () => {
    const { client, inserted } = fakeClient(statement);
    const res = await importBankTransactions(client, { accountId: "a1", rows: statement });
    expect(res).toEqual({ inserted: 0, duplicates: 2 });
    expect(inserted).toHaveLength(0);
  });

  it("the same line re-read with a different narration is still one line (balance key)", async () => {
    const { client } = fakeClient(statement);
    const reread = statement.map((r) => ({ ...r, description: "UPI RAZORPAY SOFTWARE" }));
    expect(await importBankTransactions(client, { accountId: "a1", rows: reread })).toEqual({ inserted: 0, duplicates: 2 });
  });

  it("only the line that was missing is added when the books have one of the two", async () => {
    const { client, inserted } = fakeClient([statement[0]]);
    const res = await importBankTransactions(client, { accountId: "a1", rows: statement });
    expect(res).toEqual({ inserted: 1, duplicates: 1 });
    expect(inserted[0].balance_after).toBe(11000);
  });

  it("lines without a balance keep the old narration-prefix rule (re-parsed spacing still matches)", async () => {
    const noBal = [rzp(500, null, "RZP111"), rzp(500, null, "RZP222")];
    const { client, inserted } = fakeClient([]);
    expect(await importBankTransactions(client, { accountId: "a1", rows: noBal })).toEqual({ inserted: 1, duplicates: 1 });
    expect(inserted).toHaveLength(1);
    const { client: c2 } = fakeClient([noBal[0]]);
    const respaced = [{ ...noBal[0], description: "UPI-RAZORPAY  SOFTWARE PRIVATE LIMITED-RZP999" }];
    expect(await importBankTransactions(c2, { accountId: "a1", rows: respaced })).toEqual({ inserted: 0, duplicates: 1 });
  });

  it("a stored line WITHOUT a balance + a re-upload WITH balances: nothing doubles", async () => {
    // An earlier import (no balance column) stored one line per narration prefix.
    const storedNoBal = [rzp(500, null, "RZP111"), { ...rzp(900, null), description: "NEFT CR-ACME" }];
    const { client, inserted } = fakeClient(storedNoBal);
    const reupload = [rzp(500, 10500, "RZP111"), { ...rzp(900, 11400), description: "NEFT CR-ACME" }];
    expect(await importBankTransactions(client, { accountId: "a1", rows: reupload })).toEqual({ inserted: 0, duplicates: 2 });
    expect(inserted).toHaveLength(0);
  });

  it("…and each stored no-balance line stands for ONE statement line: the one the old rule dropped comes in", async () => {
    const { client, inserted } = fakeClient([rzp(500, null, "RZP111")]);
    const res = await importBankTransactions(client, { accountId: "a1", rows: statement });
    expect(res).toEqual({ inserted: 1, duplicates: 1 });
    expect(inserted).toHaveLength(1);
  });

  it("the same line twice in one upload (same date, amount, balance) is one line", async () => {
    const { client } = fakeClient([]);
    expect(await importBankTransactions(client, { accountId: "a1", rows: [statement[0], { ...statement[0], description: "x" }] }))
      .toEqual({ inserted: 1, duplicates: 1 });
  });

  it("the dialog's preview count equals what the import inserts (one shared function)", async () => {
    const stored = [statement[0], rzp(700, null, "OLD")];
    const upload = [...statement, rzp(700, 12000, "OLD"), rzp(700, 12700, "OLD"), rzp(300, null, "X"), rzp(300, null, "X")];
    const { client } = fakeClient(stored);
    const index = await fetchExistingTxnKeys(client, "a1");
    const preview = planBankImport(upload, index);
    const res = await importBankTransactions(fakeClient(stored).client, { accountId: "a1", rows: upload });
    expect(preview.fresh.length).toBe(res.inserted);
    expect(preview.duplicates).toBe(res.duplicates);
    // and the preview did not use up the cached index
    expect(planBankImport(upload, index).fresh.length).toBe(res.inserted);
  });
});
