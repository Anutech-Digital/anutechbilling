/**
 * R-2606 — the quote's "Settle ₹X as round-off" button (UI half of R-2595).
 *
 * A part of a quote billed in parts that came in a little short (money rule P7: ≤ 1% of the part,
 * max ₹500) is closed by settle_quote_part_short (migration 20261108092350). It is booked as a SMALL
 * DIFFERENCE (round-off) on P&L "Bank Charges · Settlement short of receipt" — not a bank charge:
 * a domestic NEFT has no bank deduction (R-2577), so the wording here never says "bank charge".
 *
 * Who: owner / accountant only, exactly as the RPC (W2's small write-off roles). Other money roles
 * keep "Record ₹X balance".
 */

/* The RPC allows owner / accountant (current_user_has_role) — the same set as MONEY_DELETE_ROLES
   (W2 write-off roles); one list, not a third copy. Unknown role → NOT allowed (fail-closed). */
export function maySettleSmallShort(role: string | null | undefined): boolean {
  return !!role && (MONEY_DELETE_ROLES as readonly string[]).includes(role);
}

import { MONEY_DELETE_ROLES } from "@/lib/auth/roles";

/** The ledger the difference lands on (report_settlement_shortfalls → P&L). */
export const SETTLE_SHORT_LEDGER = "P&L → Bank Charges · Settlement short of receipt";

export function settleShortLabel(amount: number, rupee: (n: number) => string): string {
  return `Settle ${rupee(amount)} as round-off`;
}

export const SETTLE_SHORT_FORBIDDEN = "Only the owner or the accountant can settle a small difference.";
export const SETTLE_SHORT_GENERIC =
  "The small difference could not be settled — nothing was saved. Refresh the page and try again.";

/* The RPC's own refusals are written for the owner (R-2595 edgeCases) — show them as they are.
   Anything else (missing function, network) is not shown raw. */
const PLAIN_CODES: Record<string, number> = { "42501": 403, "22023": 400, P0001: 400, "28000": 401 };

export function settleShortRefusal(err: { code?: string | null; message?: string | null }): { status: number; error: string } {
  const status = err.code ? PLAIN_CODES[err.code] : undefined;
  if (status && err.message) return { status, error: err.message };
  return { status: 500, error: SETTLE_SHORT_GENERIC };
}

/** The optional note sent as p_reason (trimmed, ≤ 300 chars; empty → null). */
export function settleShortReason(body: unknown): string | null {
  const r = body && typeof body === "object" ? (body as { reason?: unknown }).reason : null;
  if (typeof r !== "string") return null;
  const t = r.trim().slice(0, 300);
  return t ? t : null;
}

/** The ₹X receipt settle_quote_part_short writes (reference BANKCHG-<line>) — not money the
 *  customer paid, so never the receipt "Send receipt" sends. */
export function isRoundOffReceipt(p: { reference?: string | null }): boolean {
  return /^BANKCHG-/.test(p.reference ?? "");
}

/**
 * What the RPC will settle, read the SAME way it picks it (review R-2606): the earliest open part
 * invoice of the quote (term_start, period_index), its net_payable − paid_amount, and the bank line
 * matched to the quote's latest receipt. The dialog shows these, and the POST refuses when the
 * amount the owner confirmed is no longer this one. Reads with the user's own session (RLS).
 */
export interface SettleShortPreview {
  amount: number;
  invoiceId: string;
  bankLine: { credit: number; txnDate: string } | null;
}

type Row = Record<string, unknown>;
interface Reader {
  from: (t: string) => {
    select: (c: string) => {
      eq: (k: string, v: unknown) => unknown;
      in: (k: string, v: readonly unknown[]) => unknown;
    };
  };
}
async function rows(q: unknown): Promise<Row[]> {
  const { data, error } = (await (q as PromiseLike<{ data: Row[] | null; error: unknown }>)) ?? { data: null, error: null };
  if (error) throw error;
  return data ?? [];
}

/** Pure part: pick the earliest open part invoice and its short (tested). */
export function pickOpenPart(
  billings: readonly { invoice_id: string | null; term_start: string | null; period_index: number | null }[],
  invoices: readonly { id: string; status: string | null; net_payable: number | null; amount: number | null; paid_amount: number | null }[],
): { invoiceId: string; amount: number } | null {
  const inv = new Map(invoices.map((i) => [i.id, i]));
  const open = billings
    .filter((b) => b.invoice_id && ["pending", "overdue"].includes(String(inv.get(b.invoice_id)?.status ?? "")))
    .sort((a, b) => (a.term_start ?? "").localeCompare(b.term_start ?? "") || (a.period_index ?? 0) - (b.period_index ?? 0)
      || String(a.invoice_id).localeCompare(String(b.invoice_id)))[0];
  if (!open?.invoice_id) return null;
  const i = inv.get(open.invoice_id)!;
  const gross = Math.round(Number(i.net_payable ?? i.amount ?? 0));
  return { invoiceId: i.id, amount: Math.max(0, gross - Math.round(Number(i.paid_amount ?? 0))) };
}

export async function settleShortPreview(db: Reader, quoteId: string): Promise<SettleShortPreview | null> {
  const subs = await rows(db.from("subscriptions").select("id").eq("quote_id", quoteId));
  if (subs.length === 0) return null;
  const bills = await rows(db.from("subscription_billings").select("invoice_id, term_start, period_index")
    .in("subscription_id", subs.map((s) => s.id)));
  const invIds = [...new Set(bills.map((b) => b.invoice_id).filter((x): x is string => typeof x === "string"))];
  if (invIds.length === 0) return null;
  const invs = await rows(db.from("invoices").select("id, status, net_payable, amount, paid_amount").in("id", invIds));
  const part = pickOpenPart(bills as never, invs as never);
  if (!part || part.amount <= 0) return null;
  const pays = (await rows(db.from("payments").select("id, received_at, created_at, status").eq("quote_id", quoteId)))
    .filter((p) => p.status === "received")
    .sort((a, b) => String(b.received_at ?? "").localeCompare(String(a.received_at ?? ""))
      || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  let bankLine: SettleShortPreview["bankLine"] = null;
  if (pays[0]) {
    const lines = (await rows(db.from("bank_transactions").select("credit, txn_date, matched_to_type").eq("matched_to_id", String(pays[0].id))))
      .filter((t) => t.matched_to_type === "payment" && Number(t.credit ?? 0) > 0);
    if (lines[0]) bankLine = { credit: Number(lines[0].credit), txnDate: String(lines[0].txn_date) };
  }
  return { amount: part.amount, invoiceId: part.invoiceId, bankLine };
}
