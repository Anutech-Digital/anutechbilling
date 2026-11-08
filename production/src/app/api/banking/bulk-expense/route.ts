/**
 * R-2611 — Banking → "Money out · no vendor yet" → Book selected.
 *
 *   POST {rows: [{txnId, category, payee}]}   (at most 100)
 *
 * Each row is booked by the EXISTING book_bank_txn_as_expense — one call (one transaction) per
 * line, on the signed-in user's own client (RLS + the function's role gate and R-1917 open-bill
 * guard). No new money rule. A refused row never stops or undoes the others: the answer lists
 * every row as booked (expense id) or refused (the reason, in the function's own words when it
 * wrote one for the user). Lines are read first so a challan / loan / salary line, a money-in or
 * an already-reconciled line is refused before any write; repeated ids are booked once.
 * GST is booked as 0 — a line with a GST bill is booked from its own Reconcile sheet.
 */
import { z } from "zod";
import { withRoute, dbFail } from "@/lib/api/with-route";
import { BULK_MAX, refuseBulkRow } from "@/lib/banking/bulk-expense";
import { Sentry } from "@/lib/sentry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES = ["owner", "manager", "accountant", "billing"] as const;
const ROLE_HINT = "Only Owner, Manager, Accountant or Billing can reconcile bank lines. Ask one of them.";

/** book_bank_txn_as_expense's own refusals (raise exception → P0001) are written for the user.
 *  42501 is also Postgres's own "permission denied" — never shown raw; the role sentence instead. */
const GUARD_CODES = new Set(["P0001"]);
/** Rows booked at once. */
const POOL = 4;

const postSchema = z.object({
  rows: z.array(z.object({
    txnId: z.string().uuid("Bank line id is not valid — refresh the page."),
    category: z.string().trim().min(1, "Choose a category for every ticked line.").max(80),
    payee: z.string().trim().max(120).optional().nullable(),
  })).min(1, "Tick at least one line.").max(BULK_MAX, `Book at most ${BULK_MAX} lines at a time.`),
});

export type BulkExpenseResult =
  | { txnId: string; ok: true; expenseId: string }
  | { txnId: string; ok: false; error: string };

type Db = {
  from: (t: string) => {
    select: (c: string) => { in: (col: string, v: string[]) => PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string } | null }> };
  };
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

interface LineRow { id: string; description: string | null; debit: number | string | null; matched_to_type: string | null }

export const POST = withRoute(
  { route: "api/banking/bulk-expense", roles: ROLES, roleHint: ROLE_HINT, input: postSchema },
  async ({ supabase, input }) => {
    const db = supabase as unknown as Db;
    const seen = new Set<string>();
    const rows = input.rows.filter((r) => !seen.has(r.txnId) && !!seen.add(r.txnId));

    const { data, error } = await db.from("bank_transactions")
      .select("id, description, debit, matched_to_type")
      .in("id", rows.map((r) => r.txnId));
    dbFail(error, "Could not read the bank lines — nothing was booked. Try again.");
    const byId = new Map(((data ?? []) as LineRow[]).map((l) => [l.id, l]));

    const bookOne = async (r: (typeof rows)[number]): Promise<BulkExpenseResult> => {
      const line = byId.get(r.txnId);
      if (!line) return { txnId: r.txnId, ok: false, error: "Bank line not found — refresh the page." };
      if (line.matched_to_type !== null) return { txnId: r.txnId, ok: false, error: "This line is already reconciled." };
      const refused = refuseBulkRow({ description: line.description, debit: Number(line.debit ?? 0) }, r.category);
      if (refused) return { txnId: r.txnId, ok: false, error: refused };
      const res = await db.rpc("book_bank_txn_as_expense", {
        p_txn_id: r.txnId, p_category: r.category, p_vendor: r.payee || null, p_gst: 0, p_notes: line.description,
      });
      if (!res.error) return { txnId: r.txnId, ok: true, expenseId: String(res.data) };
      if (res.error.code && GUARD_CODES.has(res.error.code)) return { txnId: r.txnId, ok: false, error: res.error.message };
      if (res.error.code === "42501") return { txnId: r.txnId, ok: false, error: ROLE_HINT };
      Sentry.captureException(new Error(`bulk-expense: ${res.error.code ?? ""} ${res.error.message}`), { tags: { route: "api/banking/bulk-expense" } });
      return { txnId: r.txnId, ok: false, error: "Could not book this line — open it and book it from its Reconcile sheet." };
    };

    /* Each row is its own transaction, so a few at once changes nothing but the wait (100 rows one
       by one took 15–40 s). Results keep the ticked order. */
    const results: BulkExpenseResult[] = new Array(rows.length);
    let next = 0;
    const worker = async () => { while (next < rows.length) { const i = next++; results[i] = await bookOne(rows[i]); } };
    await Promise.all(Array.from({ length: Math.min(POOL, rows.length) }, worker));
    return { results, booked: results.filter((x) => x.ok).length, refused: results.filter((x) => !x.ok).length };
  },
);
