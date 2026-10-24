/**
 * Bank statement text / rows → transaction lines (R-1512, 17 Oct 2026 — moved out of
 * import-statement-dialog.tsx so the CSV path and the Excel (.xls / .xlsx) path share ONE
 * header auto-detection + date/amount rules, and so both are unit-tested).
 *
 * Pure: no React, no network. Amounts are whole rupees (CLAUDE.md §13).
 */
import { toIstDate } from "@/lib/dates/ist";

export type ParsedRow = {
  txn_date:      string;       // ISO YYYY-MM-DD
  description:   string;
  debit:         number;       // ₹ integer
  credit:        number;       // ₹ integer
  balance_after: number | null;
  reference:     string | null;
};

export type ParseResult = { rows: ParsedRow[]; skipped: number; warnings: string[] };

// Common header aliases across Indian banks. Each canonical key maps to
// possible header names we'll match (lowercase, trimmed).
const HEADER_ALIASES: Record<keyof ParsedRow, string[]> = {
  txn_date:      ["date", "txn date", "transaction date", "value date", "post date", "tran date"],
  description:   ["description", "narration", "particulars", "details", "remarks", "transaction details"],
  debit:         ["debit", "withdrawal", "withdrawal amt", "withdrawal (dr)", "amount (debit)", "debit (rs.)", "debit amount"],
  credit:        ["credit", "deposit", "deposit amt", "deposit (cr)", "amount (credit)", "credit (rs.)", "credit amount"],
  balance_after: ["balance", "closing balance", "running balance", "available balance"],
  reference:     ["ref no", "ref no./cheque no", "reference no", "chq./ref. no.", "ref.no./cheque no", "utr no"],
};

// ─── CSV parsing ───────────────────────────────────────────────────────────
// Naive but reliable for bank statements (no embedded commas in amounts;
// quoted fields handled). For complex CSV use papaparse later if needed.
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let buf = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && inQuotes && next === '"') { buf += '"'; i++; continue; }
    if (ch === '"')              { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { cur.push(buf); buf = ""; continue; }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      cur.push(buf);
      // Only push non-empty rows
      if (cur.some((c) => c.trim().length > 0)) rows.push(cur);
      cur = []; buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf || cur.length) {
    cur.push(buf);
    if (cur.some((c) => c.trim().length > 0)) rows.push(cur);
  }
  return rows;
}

/** Rows → CSV text that parseCSV reads back cell-for-cell (quotes a cell holding , " or a newline). */
export function rowsToCsv(rows: string[][]): string {
  const cell = (c: string) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return rows.map((r) => r.map(cell).join(",")).join("\n");
}

/** Heuristic date parser — handles DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD. */
function parseDate(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  // YYYY-MM-DD already
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // DD/MM/YYYY or DD-MM-YYYY (Indian convention)
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    let yy = m[3];
    if (yy.length === 2) yy = (parseInt(yy, 10) > 50 ? "19" : "20") + yy;
    return `${yy}-${mm}-${dd}`;
  }
  // Try Date.parse fallback
  const d = new Date(s);
  if (!isNaN(d.getTime())) return toIstDate(d);   // "28 Sep 2026" = local midnight; UTC slice din peeche le jata
  return null;
}

/** Strip commas / spaces / ₹ from amount string, return integer rupees. */
function parseAmount(input: string | undefined): number {
  if (!input) return 0;
  const cleaned = input.replace(/[₹,\s]/g, "").replace(/[Cc][Rr]$/, "").replace(/[Dd][Rr]$/, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : Math.round(n);
}

/**
 * Normalise a header cell so HDFC's "Withdrawal Amt." matches the alias
 * "withdrawal amt", ICICI's "Chq.No./Ref.No." matches "chq./ref. no.", etc.
 * Strips dots, parens, slashes, extra whitespace — collapses to a single
 * lowercase token sequence.
 */
function normaliseHeader(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.()/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Given a parsed CSV (header + data rows), figure out which column index
 * holds which field. Returns null when the basic Date/Debit/Credit columns
 * can't be detected.
 */
function detectColumns(headerRow: string[]): Record<keyof ParsedRow, number> | null {
  const normalised = headerRow.map(normaliseHeader);
  const map: Partial<Record<keyof ParsedRow, number>> = {};

  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<[keyof ParsedRow, string[]]>) {
    const normAliases = aliases.map(normaliseHeader);
    for (let i = 0; i < normalised.length; i++) {
      // Match either exact or prefix (covers "withdrawal amt" ↔ "withdrawal amt rs")
      if (normAliases.some((a) => normalised[i] === a || normalised[i].startsWith(a + " "))) {
        map[field] = i;
        break;
      }
    }
  }
  if (map.txn_date == null || map.description == null) return null;
  if (map.debit == null && map.credit == null) return null;
  return {
    txn_date:      map.txn_date,
    description:   map.description,
    debit:         map.debit ?? -1,
    credit:        map.credit ?? -1,
    balance_after: map.balance_after ?? -1,
    reference:     map.reference ?? -1,
  };
}

/**
 * Rows (already split into cells — from CSV text or an Excel sheet) → lines.
 *
 * Find the first row that looks like a header. Bank statements can have a
 * LONG preamble (HDFC often runs 20-30 lines of bank name, address, account
 * details, statement period and opening balance before the table), so scan
 * the whole file — a data row won't match the date+description+amount header
 * aliases, so there's no false-positive risk.
 */
export function parseStatementRows(raw: string[][]): ParseResult {
  if (raw.length === 0) return { rows: [], skipped: 0, warnings: ["Empty file"] };

  let headerIdx = -1;
  let mapping: ReturnType<typeof detectColumns> | null = null;
  for (let i = 0; i < raw.length; i++) {
    const m = detectColumns(raw[i]);
    if (m) { headerIdx = i; mapping = m; break; }
  }
  if (headerIdx < 0 || !mapping) {
    return { rows: [], skipped: raw.length, warnings: [
      "Couldn't auto-detect column layout. Expected headers like Date, Description, Debit, Credit (or Withdrawal, Deposit).",
    ] };
  }

  const out: ParsedRow[] = [];
  let skipped = 0;
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const r = raw[i];
    const date = parseDate(r[mapping.txn_date] ?? "");
    if (!date) { skipped++; continue; }
    // Coerce to non-negative integers — a stray minus sign or a decimal would
    // otherwise break the integer column or the debit-xor-credit rule.
    const debit  = Math.max(0, mapping.debit  >= 0 ? parseAmount(r[mapping.debit])  : 0);
    const credit = Math.max(0, mapping.credit >= 0 ? parseAmount(r[mapping.credit]) : 0);
    if (debit === 0 && credit === 0) { skipped++; continue; }
    // A bank line is debit XOR credit. If a row genuinely has both populated
    // (a mis-aligned column / reversal line), we can't tell which figure is
    // right — skip it rather than invent a number or fail the whole batch.
    if (debit > 0 && credit > 0) { skipped++; continue; }
    out.push({
      txn_date:      date,
      description:   (r[mapping.description] ?? "").trim() || "(no description)",
      debit, credit,
      balance_after: mapping.balance_after >= 0 ? parseAmount(r[mapping.balance_after]) || null : null,
      reference:     mapping.reference     >= 0 ? (r[mapping.reference]?.trim() || null)        : null,
    });
  }

  return { rows: out, skipped, warnings: [] };
}

/** CSV / "Delimited" text → lines. */
export function parseStatement(text: string): ParseResult {
  return parseStatementRows(parseCSV(text));
}
