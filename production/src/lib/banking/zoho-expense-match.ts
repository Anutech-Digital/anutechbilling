/**
 * R-2655 (11 Nov 2026, G-RECON N6) — "Match Zoho expenses": the words and the sums of the preview.
 * The pairing itself is on the server (zoho_expense_bank_matches, migration
 * 20261111161638_r2655_zoho_expense_bank_match.sql): an expense imported from Zoho that Zoho paid
 * from a bank / card account (all its category parts together, by zoho_doc_id) against the OPEN
 * debits of that account — same cash (amount − TDS), within 7 days of the paid date (60 with the
 * same bank reference). This file never decides what is a clean match; it only counts and words it.
 *
 * Part 1 is the preview only: nothing is booked from here. A row opens its bank line, where the
 * expense is matched by hand ("recorded payment").
 */
import type { Route } from "next";

export type ZohoMatchStatus = "sure" | "ambiguous" | "look" | "booked_elsewhere" | "locked" | "no_line";

export interface ZohoMatchRow {
  status: ZohoMatchStatus;
  reason: string;
  zoho_doc_id: string;
  vendor_id: string | null;
  vendor_name: string | null;
  bill_no: string | null;
  categories: string | null;
  doc_date: string;
  paid_on: string;
  cash: number;
  parts: number;
  expense_ids: string[];
  reference: string | null;
  /** null: the expense was marked paid with no paid-from account (status look). */
  account_id: string | null;
  account: string | null;
  txn_id: string | null;
  txn_date: string | null;
  txn_description: string | null;
}

export const ZOHO_MATCH_STATUS_LABEL: Record<ZohoMatchStatus, string> = {
  sure: "Clean match",
  ambiguous: "More than one match",
  look: "Check by hand",
  booked_elsewhere: "Debit already booked",
  locked: "Books locked",
  no_line: "No bank line",
};

export interface ZohoMatchSummary {
  /** Clean matches: documents (each has exactly one line). */
  sure: number;
  sureAmount: number;
  /** Documents that need a look — a document with several possible lines counts once. */
  look: number;
  byStatus: Record<Exclude<ZohoMatchStatus, "sure">, number>;
}

export function zohoMatchSummary(rows: readonly ZohoMatchRow[]): ZohoMatchSummary {
  const s: ZohoMatchSummary = {
    sure: 0, sureAmount: 0, look: 0,
    byStatus: { ambiguous: 0, look: 0, booked_elsewhere: 0, locked: 0, no_line: 0 },
  };
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.zoho_doc_id)) continue;   // an ambiguous document is listed once per possible line
    seen.add(r.zoho_doc_id);
    if (r.status === "sure") { s.sure += 1; s.sureAmount += r.cash; }
    else { s.look += 1; s.byStatus[r.status] += 1; }
  }
  return s;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "12 clean matches · 5 need a look" — the one line above the lists. */
export function zohoMatchHeadline(s: ZohoMatchSummary): string {
  return `${plural(s.sure, "clean match", "clean matches")} · ${s.look} ${s.look === 1 ? "needs" : "need"} a look`;
}

/** Why the "need a look" ones are held back, most important first (a possible double expense leads). */
export function zohoMatchBreakdown(s: ZohoMatchSummary): string {
  const b = s.byStatus;
  return [
    b.booked_elsewhere > 0 && `${b.booked_elsewhere} with the debit already booked as something else`,
    b.ambiguous > 0 && `${b.ambiguous} with more than one match`,
    b.look > 0 && `${b.look} to check by hand`,
    b.no_line > 0 && `${b.no_line} with no bank line`,
    b.locked > 0 && `${b.locked} in locked books`,
  ].filter(Boolean).join(" · ");
}

/** The bank line of a row, opened on its account page (R-1895 ?txn= shows the line whatever the filters). */
export function zohoMatchLineHref(r: Pick<ZohoMatchRow, "account_id" | "txn_id">): Route | null {
  if (!r.txn_id || !r.account_id) return null;
  return `/accounting/banking/${encodeURIComponent(r.account_id)}?txn=${encodeURIComponent(r.txn_id)}` as Route;
}

/** "Amazon Retail · AMZ-1" — who and which bill; a Zoho expense with no vendor shows its category. */
export function zohoMatchDocLabel(r: Pick<ZohoMatchRow, "vendor_name" | "bill_no" | "categories">): string {
  const who = (r.vendor_name ?? "").trim() || (r.categories ?? "").trim() || "Zoho expense";
  const bill = (r.bill_no ?? "").trim();
  return bill ? `${who} · ${bill}` : who;
}
