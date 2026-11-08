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

export const SETTLE_SHORT_ROLES = ["owner", "accountant"] as const;

export function maySettleSmallShort(role: string | null | undefined): boolean {
  return !!role && (SETTLE_SHORT_ROLES as readonly string[]).includes(role);
}

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
