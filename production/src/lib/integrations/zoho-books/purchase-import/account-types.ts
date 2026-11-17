/**
 * R-2681 (17 Nov 2026) — Zoho's OWN account type keeps balance-sheet accounts out of the FY purchase
 * import, whatever the owner mapped them to (the category map is shared with bills and editable).
 * Excel's 727 no-vendor Zoho expenses hold ~Rs 1.25 Cr on such accounts: fixed deposit, Output GST,
 * GST Return, loans, advances.
 *
 * The types come from Zoho's chart of accounts (fy-fetch.ts readChartOfAccounts), stored per company in
 * zoho_account_types by the server when it reads from Zoho (route.ts). The SQL import
 * (import_zoho_fy_purchases, migration 20261117125913) is the last word; the preview (plan.ts) says the
 * same sentences in the same order:
 *   1. the company's types never read → TYPES_NOT_READ (fail closed);
 *   2. a line whose type is known and not an expense type → "Not an expense — needs another path: …";
 *      else a line whose account is missing from the read types → "… is not read yet" (fail closed);
 *   3. owner decision 17 Nov ("Haan, teeno"): a line on an UNMAPPED account leaves the document out —
 *      no more "Unmapped — review" landing. A salary account (Salaries can never be mapped) says Payroll;
 *      a Zoho expense with no vendor keeps R-2676's own sentence.
 */
import type { ZohoAccount } from "../fy-fetch";

/** Zoho's P&L cost types — the same list as SQL _r2681_is_expense_type. */
export const EXPENSE_TYPES: readonly string[] = ["expense", "other_expense", "cost_of_goods_sold"];

export const isExpenseType = (t: string | null | undefined): boolean =>
  typeof t === "string" && EXPENSE_TYPES.includes(t.trim().toLowerCase());

/** "other_current_liability" → "other current liability" (as the SQL's replace(type, '_', ' ')). */
export const typeLabel = (t: string): string => t.replace(/_/g, " ");

export const TYPES_NOT_READ = "Zoho account types are not read yet — press Read from Zoho again, then preview again.";
/** A Zoho line with no account cannot be typed or mapped — it never comes in by itself. */
export const NO_ACCOUNT_LINE = "A line has no account in Zoho — add it by hand.";

/** Stored types older than this are read again with the next Zoho read (one call per 200 accounts). */
export const TYPES_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export const NOT_AN_EXPENSE_PREFIX = "Not an expense — needs another path";

export function notAnExpenseReason(name: string, type: string): string {
  return `${NOT_AN_EXPENSE_PREFIX}: Zoho account "${name}" is a ${typeLabel(type)} account in Zoho. Fixed deposits, loans, GST, assets and advances are never booked as an expense.`;
}

interface Line { accountId: string; accountName: string }
const nameOf = (l: Line) => l.accountName.trim() || l.accountId.trim() || "?";

/**
 * Why a document cannot come in by Zoho's account type; null when every line is an expense type.
 * `types` = this company's stored types (Zoho account id → type); empty = never read.
 */
export function accountTypeRefusal(lines: readonly Line[], types: Readonly<Record<string, string>>): string | null {
  if (lines.some((l) => !l.accountId.trim())) return NO_ACCOUNT_LINE;
  if (Object.keys(types).length === 0) return TYPES_NOT_READ;
  const known = lines.find((l) => {
    const t = types[l.accountId];
    return t !== undefined && !isExpenseType(t);
  });
  if (known) return notAnExpenseReason(nameOf(known), types[known.accountId]);
  const missing = lines.find((l) => types[l.accountId] === undefined);
  if (missing) return `Zoho's account type for "${nameOf(missing)}" is not read yet — press Read from Zoho again, then preview again.`;
  return null;
}

const SALARY = /(salar|wage|payroll)/i;

/** R-2676's sentence for a Zoho expense with no vendor on an unmapped account (unchanged). */
export function noVendorUnmappedReason(name: string): string {
  return `Zoho account "${name}" is not mapped to an expense category — map it only if it is an expense. A fixed deposit, loan, GST, asset or salary payment is not an expense and stays out.`;
}

/**
 * Owner decision 17 Nov: a line on an unmapped account leaves the whole document out. `isMapped` says
 * whether an account id has an allowed category. `noVendor` = a Zoho EXPENSE with no vendor name and no
 * Zoho vendor id (R-2676's sentence).
 */
export function unmappedRefusal(lines: readonly Line[], isMapped: (accountId: string) => boolean, noVendor: boolean): string | null {
  const l = lines.find((x) => !isMapped(x.accountId));
  if (!l) return null;
  const name = nameOf(l);
  if (noVendor) return noVendorUnmappedReason(name);
  if (SALARY.test(name)) return `Zoho account "${name}" is a salary — Payroll books salaries, so it is not imported from Zoho (owner, 17 Nov).`;
  return `Zoho account "${name}" is not mapped — left out for now (owner, 17 Nov). Map it only if it is an expense.`;
}

/**
 * Read Zoho's chart of accounts again? None stored, the newest read is older than TYPES_MAX_AGE_MS, or
 * older than the start of the current Zoho list read (`readStartedAt` — "Read from Zoho again" starts a
 * new one, so an account made in Zoho since the last read gets its type on that press).
 */
export function typesStale(newestReadAt: string | null, nowMs: number, readStartedAt: string | null = null): boolean {
  if (!newestReadAt) return true;
  const t = Date.parse(newestReadAt);
  if (!Number.isFinite(t) || nowMs - t > TYPES_MAX_AGE_MS) return true;
  const s = readStartedAt ? Date.parse(readStartedAt) : NaN;
  return Number.isFinite(s) && t < s;
}

/** Rows for save_zoho_account_types from Zoho's chart of accounts (ids and types trimmed; empty / repeated ones dropped). */
export function accountTypeRows(accounts: readonly ZohoAccount[]) {
  const seen = new Set<string>();
  const out: Array<{ zoho_account_id: string; zoho_account_name: string; account_type: string }> = [];
  for (const a of accounts) {
    const id = a.id.trim();
    const type = a.type.trim().toLowerCase();
    if (!id || id.length > 40 || !type || type.length > 60 || seen.has(id)) continue;
    seen.add(id);
    out.push({ zoho_account_id: id, zoho_account_name: a.name.trim().slice(0, 200), account_type: type });
  }
  return out;
}
