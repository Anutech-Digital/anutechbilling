/**
 * Bank Reconciliation Statement — books vs the bank, one account, one date.
 *
 * In this app the bank table holds two kinds of line: what the BANK said (imported:
 * csv_upload / api_fetch) and what WE booked without a statement (manual — a bill
 * paid from the Bills page, a salary marked paid, a cheque issued). So:
 *
 *   balance per bank statement = opening + Σ imported (credit − debit) up to the date
 *   balance per books          = opening + Σ all lines (credit − debit) up to the date
 *   books − statement          = manual credits (deposits in transit)
 *                              − manual debits  (payments not yet through the bank)
 *
 * and the classic BRS reads: statement balance + deposits in transit − cheques not
 * presented = book balance. The second half of the statement is the ACTION list —
 * imported lines nobody has booked (bank charges, interest, an unknown receipt): the
 * bank knows about them, the books do not.
 *
 * If the owner types the closing balance printed on the bank's own statement, a
 * difference from the imported balance means lines are missing from the import (or
 * were deleted) — the one thing no amount of reconciling fixes.
 */

import { formatDate } from "@/lib/utils";

export interface BrsLine {
  id: string;
  txn_date: string;
  description: string;
  debit: number;
  credit: number;
  source: "manual" | "csv_upload" | "api_fetch";
  matched_to_type: string | null;
}

export interface BrsInput {
  openingBalance: number;
  openingDate: string;           // YYYY-MM-DD — lines before this are not in the ledger
  asOf: string;                  // YYYY-MM-DD inclusive
  lines: BrsLine[];
  /** Closing balance printed on the bank's statement for `asOf`, if typed. */
  statementClosing?: number | null;
}

export interface Brs {
  asOf: string;
  statementBalance: number;      // per imported lines
  bookBalance: number;           // per all lines
  depositsInTransit: BrsLine[];  // manual credits — booked, not yet in the bank
  paymentsNotPresented: BrsLine[]; // manual debits — booked, not yet through the bank
  unbookedImports: BrsLine[];    // imported, unreconciled — in the bank, not in the books
  totals: { depositsInTransit: number; paymentsNotPresented: number; unbookedImports: number };
  /** statementClosing − statementBalance, when a closing balance was typed. Non-zero = missing lines. */
  importGap: number | null;
  /** Everything ties out: no unbooked imports and no import gap. */
  clean: boolean;
  ignoredBeforeOpening: number;  // lines dated before the opening balance date (not counted)
}

const IMPORTED = new Set(["csv_upload", "api_fetch"]);

export function buildBrs(i: BrsInput): Brs {
  const inRange = i.lines.filter((l) => l.txn_date <= i.asOf && l.txn_date >= i.openingDate);
  const ignoredBeforeOpening = i.lines.filter((l) => l.txn_date < i.openingDate && l.txn_date <= i.asOf).length;
  const net = (rows: BrsLine[]) => rows.reduce((s, l) => s + (l.credit || 0) - (l.debit || 0), 0);
  const imported = inRange.filter((l) => IMPORTED.has(l.source));
  const manual = inRange.filter((l) => !IMPORTED.has(l.source));
  const statementBalance = Math.round(i.openingBalance + net(imported));
  const bookBalance = Math.round(i.openingBalance + net(inRange));
  const byDate = (a: BrsLine, b: BrsLine) => a.txn_date.localeCompare(b.txn_date) || a.description.localeCompare(b.description);
  const depositsInTransit = manual.filter((l) => (l.credit || 0) > 0).sort(byDate);
  const paymentsNotPresented = manual.filter((l) => (l.debit || 0) > 0).sort(byDate);
  const unbookedImports = imported.filter((l) => l.matched_to_type === null).sort(byDate);
  const totals = {
    depositsInTransit: depositsInTransit.reduce((s, l) => s + l.credit, 0),
    paymentsNotPresented: paymentsNotPresented.reduce((s, l) => s + l.debit, 0),
    unbookedImports: unbookedImports.reduce((s, l) => s + (l.credit || 0) - (l.debit || 0), 0),
  };
  return withStatementClosing({
    asOf: i.asOf, statementBalance, bookBalance, depositsInTransit, paymentsNotPresented, unbookedImports, totals,
    importGap: null, clean: false, ignoredBeforeOpening,
  }, i.statementClosing);
}

/**
 * The statement-closing part of a BRS (importGap, clean). R-2566: the page builds the lists once
 * per account / date and calls only this on each keystroke in "Closing balance" (buildBrs sorts
 * 5,000+ lines). buildBrs itself ends here, so both always give the same answer.
 */
export function withStatementClosing(b: Brs, statementClosing: number | null | undefined): Brs {
  const importGap = statementClosing === null || statementClosing === undefined ? null : Math.round(statementClosing) - b.statementBalance;
  return { ...b, importGap, clean: b.unbookedImports.length === 0 && (importGap === null || importGap === 0) };
}

/** The statement as rows for a CSV / print — the way a CA reads it. */
export function brsRows(b: Brs, accountName: string): (string | number)[][] {
  const out: (string | number)[][] = [
    ["Bank reconciliation statement", accountName], ["As of", b.asOf], ["", ""],
    ["Balance as per bank statement (imported lines)", b.statementBalance],
    ["Add: deposits in transit (booked, not yet in the bank)", b.totals.depositsInTransit],
    ...b.depositsInTransit.map((l): [string, number] => [`    ${l.txn_date} ${l.description}`, l.credit]),
    ["Less: payments not yet presented (booked, not yet through the bank)", b.totals.paymentsNotPresented],
    ...b.paymentsNotPresented.map((l): [string, number] => [`    ${l.txn_date} ${l.description}`, -l.debit]),
    ["Balance as per books", b.bookBalance], ["", ""],
    ["In the bank, not in the books (unreconciled imported lines)", b.totals.unbookedImports],
    ...b.unbookedImports.map((l): [string, number] => [`    ${l.txn_date} ${l.description}`, (l.credit || 0) - (l.debit || 0)]),
  ];
  if (b.importGap !== null) out.push(["", ""], ["Closing balance per bank's statement − imported balance (missing lines)", b.importGap]);
  return out;
}

/**
 * R-2566: how many lines a BRS list paints at a time. With 5,000+ bank lines on one account the
 * page painted ~3,500 "In bank, not in books" rows at once and froze the tab. The counts and ₹
 * totals above each list still come from EVERY line (buildBrs); only the painting is paged.
 */
export const BRS_PAGE_SIZE = 100;

/**
 * The lines a search box keeps: text in the narration; the date as the list shows it ("15 Oct
 * 2026", "15 oct") or as YYYY-MM-DD; or the amount as shown (whole rupees — "₹1,235" / "1235"
 * finds a ₹1,234.50 line; ₹ and commas ignored). Only the line's own money side is compared
 * (a money-in line is never found by its empty debit side).
 */
export function searchBrsLines(rows: readonly BrsLine[], query: string): BrsLine[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return rows as BrsLine[];
  const digits = q.replace(/[₹,\s]/g, "");
  const amountQuery = /^\d+(\.\d+)?$/.test(digits) ? digits : null;
  return rows.filter((l) => {
    if ((l.description ?? "").toLowerCase().includes(q) || l.txn_date.includes(q)) return true;
    if (formatDate(l.txn_date).toLowerCase().includes(q)) return true;
    if (amountQuery === null) return false;
    const amt = (l.credit || 0) > 0 ? l.credit : (l.debit || 0);
    if (amt <= 0) return false;
    return String(Math.round(amt)).includes(amountQuery) || String(amt).includes(amountQuery);
  });
}
