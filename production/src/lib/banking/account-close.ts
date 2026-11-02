/**
 * R-2384 — close (archive) a bank account, e.g. a broken FD at ₹0.
 *
 * Pardeep, 2 Nov 2026: "jo FD break ho chuki ho unhe archive me rakho aur latest update show karo".
 * A closed account (is_active = false) leaves the Banking list and every picker for NEW money, but
 * keeps all its lines, matches and report figures. The server is the judge
 * (trg_bank_account_close_guard, migration 20261102134054): closing is allowed only at ₹0 and never
 * for the company's default Petty Cash. The helpers here only explain the same rule before the click.
 */
import { rupee } from "@/lib/utils";

export type ClosableAccount = {
  is_active: boolean;
  account_type: string;
  opening_balance: number;
  current_balance?: number | null;
  is_default_petty_cash?: boolean | null;
};

/** Why "Close account" is not possible right now, or null when it is. */
export function closeAccountProblem(acc: ClosableAccount): string | null {
  if (!acc.is_active) return "This account is already closed.";
  if (acc.is_default_petty_cash) return "The company's Petty Cash cannot be closed — it is the default cash account.";
  const balance = acc.current_balance ?? acc.opening_balance;
  if (balance !== 0) {
    const shown = acc.account_type === "credit_card" && balance < 0 ? `${rupee(-balance)} owed` : rupee(balance);
    return `Balance is ${shown}. An account can be closed only at ₹0 — move the money out first with Own transfer, then close it.`;
  }
  return null;
}

/** Banking list: active accounts first-class, closed ones behind the "Closed (N)" toggle. */
export function splitByStatus<T extends { is_active: boolean }>(accounts: ReadonlyArray<T> | null | undefined): { active: T[]; closed: T[] } {
  const active: T[] = [];
  const closed: T[] = [];
  for (const a of accounts ?? []) (a.is_active === false ? closed : active).push(a);
  return { active, closed };
}

/**
 * Pickers for NEW money: active accounts, plus the one already saved on the record being edited
 * (so an old payment that went into a now-closed FD still shows where it went).
 */
export function pickableAccounts<T extends { id: string; is_active: boolean }>(
  accounts: ReadonlyArray<T> | null | undefined,
  keepId?: string | null,
): T[] {
  return (accounts ?? []).filter((a) => a.is_active !== false || (keepId != null && a.id === keepId));
}

export const FD_MOVE_WARNING =
  "This moves money to/from an FD — use Own transfer so the FD balance changes.";

/* An FD number in a narration: "FD 1234", "FD NO.1234", "FDR/00123", "FD A/C 1234", "TD 1234",
   or the words "fixed deposit", "sweep", "redeem/redemption", "premat/pre-mat/premature". */
const FD_WORDS = /\b(?:sweep|swp|redeem\w*|redemption|pre-?mat\w*|fixed\s*deposit|term\s*deposit)\b/i;
const FD_NUMBER = /\b(?:fdr?|td|tdr)\s*(?:no\.?|a\/c|ac|#|\/|-|:)?\s*\d{3,}/i;

/**
 * R-2384 — "Mark reconciled manually" on a line that moves money to/from an FD leaves the FD's
 * balance wrong. Returns the warning (warning only — saving is still allowed) or null.
 */
export function fdMoveWarning(description: string | null | undefined): string | null {
  const d = description ?? "";
  return FD_WORDS.test(d) || FD_NUMBER.test(d) ? FD_MOVE_WARNING : null;
}
