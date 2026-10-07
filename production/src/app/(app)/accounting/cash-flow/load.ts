/**
 * Cash Flow's data — the bank lines in the range and the balance the range starts from.
 *
 * R-265 (7 Oct 2026): both reads used to be a bare `select` with no `.range()`. PostgREST
 * answers at most 1000 rows (supabase/config.toml max_rows) and says nothing when it cut the
 * answer short, so past 1000 bank lines the opening balance summed only the first 1000 lines
 * before the range — the starting cash was wrong, and every month's closing with it, while the
 * page looked whole. Every read now pages with fetchAllRows on a total order (… , id), so the
 * last month ends on the same figure bank_account_current_balance() gives.
 *
 * Out of the page so it can be tested with a fake client that caps at 1000 rows like the server.
 */
import type { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import type { CashFlowTxn } from "@/lib/accounting/cash-flow-lines";

type Client = ReturnType<typeof createClient>;

export type CashFlowData = { lines: CashFlowTxn[]; balanceBefore: number };

export async function loadCashFlow(supabase: Client, from: string | null, to: string | null): Promise<CashFlowData> {
  /* The balance the first month starts from: every account's opening balance plus every line
     dated before the range — the same sum bank_account_current_balance() makes, so the last
     month ends on the bank's own balance. */
  const [accts, before, data] = await Promise.all([
    fetchAllRows((a, b) =>
      supabase.from("bank_accounts").select("id, opening_balance").order("id").range(a, b)),
    from
      ? fetchAllRows((a, b) =>
          supabase.from("bank_transactions").select("id, credit, debit")
            .lt("txn_date", from).order("id").range(a, b))
      : Promise.resolve([] as { credit: number | null; debit: number | null }[]),
    /* The whole line, not just amounts: the month drill-down lists these same rows, so its
       totals are the row's totals by construction. */
    fetchAllRows((a, b) => {
      let q = supabase
        .from("bank_transactions")
        .select("id, bank_account_id, txn_date, description, debit, credit, matched_to_type, category");
      if (from) q = q.gte("txn_date", from);
      if (to)   q = q.lte("txn_date", to);
      return q.order("txn_date").order("id").range(a, b);
    }),
  ]);

  const balanceBefore = accts.reduce((s, a) => s + (a.opening_balance ?? 0), 0)
    + before.reduce((s, t) => s + (t.credit ?? 0) - (t.debit ?? 0), 0);

  const lines = data.map((t) => ({
    id: t.id,
    bank_account_id: t.bank_account_id,
    txn_date: t.txn_date,
    description: t.description ?? null,
    debit: t.debit ?? 0,
    credit: t.credit ?? 0,
    matched_to_type: t.matched_to_type ?? null,
    category: t.category ?? null,
  }));
  return { lines, balanceBefore };
}
