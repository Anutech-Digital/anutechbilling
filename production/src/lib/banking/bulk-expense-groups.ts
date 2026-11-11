/**
 * R-2657 — "No-vendor lines" sheet, grouped by payee (G-RECON plan N4; RECON-SPEED research items
 * 7 and 10). HDFC 4523 had 332 small UPI / POS lines where 36 payees cover 170 lines, and R-2611's
 * sheet needed one category pick per LINE. Here the lines are grouped by who was paid — the same
 * narration key the Reconcile sheet's vendor memory uses (lib/banking/narration-key.ts, R-1919) —
 * so one pick books the whole group, and "Always book like this" saves a Category Rule for the
 * next statement.
 *
 * The bank's own GST on its charges ("…DPO2608902104710 CGST" / "… SGST", ₹20–200 each, 93 lines)
 * is one group of its own and is suggested as Bank Charges — an expense with GST ₹0. Pardeep's D1
 * (10 Nov): the no-vendor tool never claims input GST (a filed month must not change); claiming
 * that ITC in months not yet filed is R-2664.
 *
 * Pure: no React, no database. The sheet and its tests read the same functions.
 */
import { narrationKey } from "./narration-key";
import { AUTO_TICK_MAX, isBankGstLine, isSafeRuleKey, ruleUnsafeLine, wholeWordMatch, type BulkRow } from "./bulk-expense";

export const BANK_GST_KEY = "bank-gst";
export const BANK_GST_LABEL = "Bank GST on charges (DPO… CGST / SGST)";

/** The group a line belongs to: bank GST, else its payee key, else the line alone. */
export function groupKeyOf(row: { id: string; description: string | null }): string {
  if (isBankGstLine(row.description)) return BANK_GST_KEY;
  const k = narrationKey(row.description);
  return k ? `payee:${k}` : `line:${row.id}`;
}

const norm = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/\s+/g, " ").trim();

/**
 * The Category Rule text for a payee group, or null when no safe rule exists. Category Rules match
 * a narration by substring elsewhere (lib/banking/categorise.ts), and in this tool only as whole
 * word(s) of a full payee text (bulk-expense.ts isSafeRuleKey / wholeWordMatch — independent review,
 * 11 Nov: rule RAVI must never tick "RAVINDRA STEELS"). So a rule is offered only when the payee
 * text has 2+ real words or one word of 6+ letters (no rail / bank / generic word), stands as whole
 * word(s) in EVERY line of the group, and no line of the group is cash from an ATM, an own-account
 * transfer, salary, a tax challan or a loan / EMI. The bank-GST group needs no rule — it has its
 * built-in default.
 */
export function rulePatternFor(key: string, rows: readonly { description: string | null }[]): string | null {
  if (!key.startsWith("payee:")) return null;
  const pattern = norm(key.slice("payee:".length));
  if (!isSafeRuleKey(pattern) || rows.length === 0) return null;
  if (rows.some((r) => ruleUnsafeLine(r.description) || !wholeWordMatch(r.description, pattern))) return null;
  return pattern;
}

export interface PayeeGroup {
  key: string;
  /** What the owner reads: the payee as the narration spells it, or the bank-GST label. */
  label: string;
  rows: BulkRow[];
  total: number;
  min: number;
  max: number;
  /** The one category every row of the group was suggested ("" when they differ or none). */
  category: string;
  /** "Always book like this" text, null = no safe rule (the option is not offered). */
  rulePattern: string | null;
}

const labelOf = (key: string, rows: readonly BulkRow[]): string => {
  if (key === BANK_GST_KEY) return BANK_GST_LABEL;
  const payee = rows.find((r) => r.payee)?.payee;
  if (payee) return payee;
  if (key.startsWith("payee:")) return key.slice("payee:".length).replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return rows[0]?.description || "—";
};

/** The sheet's rows grouped by payee — biggest groups first, then by label (stable). */
export function payeeGroups(rows: readonly BulkRow[]): PayeeGroup[] {
  const byKey = new Map<string, BulkRow[]>();
  for (const r of rows) {
    const k = groupKeyOf(r);
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  const out: PayeeGroup[] = [];
  for (const [key, list] of byKey) {
    const cats = new Set(list.map((r) => r.category));
    out.push({
      key,
      label: labelOf(key, list),
      rows: list,
      total: list.reduce((s, r) => s + r.debit, 0),
      min: Math.min(...list.map((r) => r.debit)),
      max: Math.max(...list.map((r) => r.debit)),
      category: cats.size === 1 ? [...cats][0] : "",
      rulePattern: rulePatternFor(key, list),
    });
  }
  return out.sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

/**
 * "Pick a category for the group": every row of the group gets it, except rows the owner already
 * changed by hand on their own (their own edit wins — a group pick never overwrites a row edit).
 */
export function applyGroupCategory(
  group: Pick<PayeeGroup, "rows">,
  category: string,
  edits: Readonly<Record<string, { category?: string; payee?: string; byRow?: boolean }>>,
): Record<string, { category?: string; payee?: string; byRow?: boolean }> {
  const next = { ...edits };
  for (const r of group.rows) {
    if (next[r.id]?.byRow && next[r.id]?.category !== undefined) continue;
    next[r.id] = { ...next[r.id], category };
  }
  return next;
}

/** "Tick group": every line of the group under ₹1,00,000 (a big line is ticked by hand only). */
export const tickGroupIds = (group: Pick<PayeeGroup, "rows">): string[] =>
  group.rows.filter((r) => r.debit < AUTO_TICK_MAX).map((r) => r.id);
