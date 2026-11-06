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
  /** R-2522: the bank's value date (HDFC "Value Dt"), when the file has its own column for it.
      Sent to the database; the opening move uses it to place a line at the meeting point. */
  value_date?:   string | null;
  /** R-2528: the amount in PAISE as printed (always ≥ 0; the side is debit/credit), present only
      when the printed amount has paise. Sent to the database (net_paise) so the opening move
      compares the statement in paise and a missing ₹17.70 line is never taken as rounding. */
  amount_paise?: number;
  /** R-2528: the running balance in paise as printed, present only when it has paise. */
  balance_paise?: number;
  /** R-2495: the bank printed this line with a NEGATIVE amount (a reversal — e.g. a failed
      ATM withdrawal shown as debit -20000), so it was read as the opposite side. Preview only. */
  reversal?:     true;
  /** R-2508: the line has a minus in an amount column and the file does not show whether that is
      money back in (a reversal) or money out. Shown as money in for now; the import waits until
      the owner chooses (applySignChoice). Preview only — never sent to the database. */
  checkSign?:    true;
};

export type ParseResult = { rows: ParsedRow[]; skipped: number; warnings: string[] };

// Common header aliases across Indian banks. Each canonical key maps to
// possible header names we'll match (lowercase, trimmed).
/** The columns read from a statement (`reversal` is worked out, not a column). */
type ColumnField = Exclude<keyof ParsedRow, "reversal" | "checkSign">;

const HEADER_ALIASES: Record<ColumnField, string[]> = {
  txn_date:      ["date", "txn date", "transaction date", "value date", "post date", "tran date"],
  description:   ["description", "narration", "particulars", "details", "remarks", "transaction details"],
  debit:         ["debit", "withdrawal", "withdrawal amt", "withdrawal (dr)", "amount (debit)", "debit (rs.)", "debit amount"],
  credit:        ["credit", "deposit", "deposit amt", "deposit (cr)", "amount (credit)", "credit (rs.)", "credit amount"],
  balance_after: ["balance", "closing balance", "running balance", "available balance"],
  reference:     ["ref no", "ref no./cheque no", "reference no", "chq./ref. no.", "ref.no./cheque no", "utr no"],
  value_date:    ["value dt", "value date"],
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

const NUMERIC_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/;

/**
 * R-1890: day-first or month-first is decided ONCE for the whole file, never per line.
 * A first part over 12 anywhere proves day-first; otherwise a second part over 12 proves
 * month-first; with no proof either way, Indian banks are day-first.
 */
export function detectDayOrder(cells: string[]): "dmy" | "mdy" {
  let firstOver12 = false, secondOver12 = false;
  for (const c of cells) {
    const m = NUMERIC_DATE.exec(c.trim());
    if (!m) continue;
    if (Number(m[1]) > 12) firstOver12 = true;
    if (Number(m[2]) > 12) secondOver12 = true;
  }
  return !firstOver12 && secondOver12 ? "mdy" : "dmy";
}

/** Heuristic date parser — handles DD/MM/YYYY (or MM/DD for the whole file), DD-MM-YYYY, YYYY-MM-DD. */
function parseDate(input: string, order: "dmy" | "mdy" = "dmy"): string | null {
  const s = input.trim();
  if (!s) return null;
  // YYYY-MM-DD already — never swapped (R-1890)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // DD/MM/YYYY or DD-MM-YYYY (Indian convention), or MM/DD/YYYY when the file proved it
  const m = s.match(NUMERIC_DATE);
  if (m) {
    const [a, b] = order === "mdy" ? [m[2], m[1]] : [m[1], m[2]];
    const dd = a.padStart(2, "0");
    const mm = b.padStart(2, "0");
    let yy = m[3];
    if (yy.length === 2) yy = (parseInt(yy, 10) > 50 ? "19" : "20") + yy;
    return `${yy}-${mm}-${dd}`;
  }
  // Try Date.parse fallback
  const d = new Date(s);
  if (!isNaN(d.getTime())) return toIstDate(d);   // "28 Sep 2026" = local midnight; UTC slice din peeche le jata
  return null;
}

/**
 * Strip commas / spaces / ₹ from amount string, return integer rupees, sign kept.
 * R-2495: a negative is also written "(20,000.00)" or "20,000.00-" by some banks.
 */
export function parseAmount(input: string | undefined): number {
  return signedRound(parseAmountExact(input));
}

/** R-2528: the same amount in whole paise, sign kept. */
export function parseAmountPaise(input: string | undefined): number {
  return signedRound(parseAmountExact(input) * 100);
}

/** The printed amount as a number (paise kept), sign kept; 0 when unreadable. */
function parseAmountExact(input: string | undefined): number {
  if (!input) return 0;
  let cleaned = input.replace(/[₹,\s]/g, "").replace(/[Cc][Rr]$/, "").replace(/[Dd][Rr]$/, "");
  let sign = 1;
  const paren = /^\((.*)\)$/.exec(cleaned);
  if (paren) { cleaned = paren[1]; sign = -1; }
  else if (/^\d[\d.]*-$/.test(cleaned)) { cleaned = cleaned.slice(0, -1); sign = -1; }
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : sign * n;
}

/**
 * R-2508: whole rupees with the sign put on AFTER rounding the size — Math.round alone rounds
 * .5 toward +infinity, so "-20000.50" gave -20000 while "(20000.50)" gave -20001, and a
 * withdrawal and its reversal left ₹1 behind. Never returns -0.
 */
export function signedRound(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const r = Math.round(Math.abs(n));
  return r === 0 ? 0 : Math.sign(n) * r;
}

/**
 * R-2495: does this amount column write EVERY amount with a minus (a "signed" export, e.g. all
 * withdrawals as -1000)? Then a minus there is just the column's style, not a reversal. Decided
 * once per file (or per AI answer): at least SIGNED_MIN negatives and more negative than
 * positive non-zero values — so one reversal alone in a short file is still a reversal.
 */
const SIGNED_MIN = 3;
export function columnIsSigned(values: readonly number[]): boolean {
  let neg = 0, pos = 0;
  for (const v of values) { if (v < 0) neg++; else if (v > 0) pos++; }
  return neg >= SIGNED_MIN && neg > pos;
}

/**
 * R-2495: a bank line's two amount cells → one clean side. A NEGATIVE debit is money back in
 * (HDFC prints a failed ATM withdrawal's reversal as "debit -20000"), so it becomes a credit of
 * the same amount; a negative credit becomes a debit. `reversal` says the sign was flipped.
 * Never clamp it to 0: a dropped reversal makes the running-balance check report a false gap.
 *  - A column that writes every amount negative (`signed`) only loses its minus.
 *  - Both cells filled (any sign) stays both-sided, so the caller skips it as before — we
 *    cannot tell which figure is right, and must not add them up.
 */
export function signedAmounts(
  debitRaw: number,
  creditRaw: number,
  signed: { debit?: boolean; credit?: boolean } = {},
): { debit: number; credit: number; reversal: boolean } {
  if (debitRaw !== 0 && creditRaw !== 0) return { debit: Math.abs(debitRaw), credit: Math.abs(creditRaw), reversal: false };
  if (debitRaw < 0 && signed.debit)   return { debit: -debitRaw, credit: 0, reversal: false };
  if (creditRaw < 0 && signed.credit) return { debit: 0, credit: -creditRaw, reversal: false };
  if (debitRaw < 0)  return { debit: 0, credit: -debitRaw, reversal: true };
  if (creditRaw < 0) return { debit: -creditRaw, credit: 0, reversal: true };
  return { debit: debitRaw, credit: creditRaw, reversal: false };
}

/** Rows read as reversals, counted — for the preview warning (CSV, Excel and AI alike). A line
    still waiting for the owner ("check sign", R-2508) is not counted: it is not settled yet. */
export function countReversals(rows: readonly { reversal?: true; checkSign?: true }[]): number {
  return rows.reduce((n, r) => n + (r.reversal && !r.checkSign ? 1 : 0), 0);
}

/** R-2508: lines whose sign the owner must confirm before the import can go ahead. */
export function signCheckCount(rows: readonly { checkSign?: true }[]): number {
  return rows.reduce((n, r) => n + (r.checkSign ? 1 : 0), 0);
}

/* ── R-2508: is a minus a reversal? The file's own running balance says ──────────────────
   The independent review of R-2495 found that with only 1–2 negatives in a file (or in one AI
   chunk) and no balance column, a withdrawal written "-20000" was booked as ₹20,000 IN. Now a
   line read as a reversal is kept as one only when the balance moved UP by its amount next to
   it; moved DOWN → it was money out (the minus was the column's style); anything else → the
   line is marked checkSign and the import waits for the owner. Never guessed silently. */

/** ₹1 either way: amounts and balances are each rounded to whole rupees. */
const CHAIN_TOLERANCE = 1;
const near = (a: number, b: number) => Math.abs(a - b) <= CHAIN_TOLERANCE;
const netOf = (r: ParsedRow) => r.credit - r.debit;
const hasBalance = (r: ParsedRow | undefined): r is ParsedRow & { balance_after: number } =>
  r != null && r.balance_after != null;

/** Oldest-first ("asc") or newest-first ("desc") — read from settled lines only. */
function chainDirection(rows: readonly ParsedRow[]): "asc" | "desc" | null {
  let asc = 0, desc = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (!hasBalance(a) || !hasBalance(b) || a.reversal || b.reversal) continue;
    if (near(b.balance_after - a.balance_after, netOf(b))) asc++;
    if (near(a.balance_after - b.balance_after, netOf(a))) desc++;
  }
  return asc > desc ? "asc" : desc > asc ? "desc" : null;
}

/** The balance next to line i: does it agree with the flipped reading, the printed one, or neither? */
function reversalVerdict(rows: readonly ParsedRow[], i: number, dir: "asc" | "desc" | null): "flipped" | "printed" | "unknown" {
  const r = rows[i];
  if (!hasBalance(r)) return "unknown";
  const net = netOf(r);                       // the flipped (reversal) reading's movement
  /* The line BEFORE it in time: the previous line in an oldest-first file, the next one in a
     newest-first file. No settled lines to tell the order → oldest-first, as banks print and the
     AI prompt asks — never both neighbours (the wrong one only matches by coincidence). */
  const n = rows[dir === "desc" ? i + 1 : i - 1];
  if (!hasBalance(n)) return "unknown";
  const moved = r.balance_after - n.balance_after;
  const flipped = near(moved, net), printed = near(moved, -net);
  if (flipped && !printed) return "flipped";
  if (printed && !flipped) return "printed";
  return "unknown";
}

const stripMark = (d: string) => (d.endsWith(REVERSAL_MARK) ? d.slice(0, -REVERSAL_MARK.length) : d);

/** The line as printed: the minus meant money out (or in, for a credit column) — no mark. */
function asPrinted<T extends ParsedRow>(r: T): T {
  const { reversal: _r, checkSign: _c, ...rest } = r;
  return { ...rest, debit: r.credit, credit: r.debit, description: stripMark(r.description) } as T;
}
/** A settled reversal: money back in, narration marked. */
function asReversal<T extends ParsedRow>(r: T): T {
  const { checkSign: _c, ...rest } = r;
  return { ...rest, description: stripMark(r.description) + REVERSAL_MARK } as T;
}
/** Not settled: shown as the reversal reading but WITHOUT the "(reversal)" mark — it is not one yet. */
function asUnsettled<T extends ParsedRow>(r: T): T {
  return { ...r, description: stripMark(r.description), checkSign: true as const };
}

/**
 * Settle every line read as a reversal against the running balance (see above). Same answer
 * when run again — the CSV / Excel parser runs it, and the dialog runs it once more over the
 * merged AI chunks, where a line on a chunk's edge finally has its neighbour.
 * `final: false` (one AI chunk of a longer PDF): "printed" is NOT decided there — that drops the
 * reversal flag, so the dialog's run over the whole statement could never look again. The line
 * stays "check sign" until the whole-statement run settles it.
 */
export function settleReversals<T extends ParsedRow>(rows: readonly T[], opts: { final?: boolean } = {}): T[] {
  if (!rows.some((r) => r.reversal)) return [...rows];
  const final = opts.final ?? true;
  const dir = chainDirection(rows);
  return rows.map((r, i) => {
    if (!r.reversal) return r;
    const v = reversalVerdict(rows, i, dir);
    if (v === "flipped") return asReversal(r);
    if (v === "printed" && final) return asPrinted(r);
    return asUnsettled(r);
  });
}

/**
 * R-2508: the owner's answer for one "check sign" line — "reversal" (the minus means the money
 * moved back: a Withdrawal-column minus is money IN, a Deposit-column minus money OUT) or
 * "printed" (the minus is only how the file writes that column).
 */
export type SignChoice = "reversal" | "printed";
export function applySignChoice<T extends ParsedRow>(rows: readonly T[], index: number, choice: SignChoice): T[] {
  return rows.map((r, i) => {
    if (i !== index || !r.checkSign) return r;
    return choice === "reversal" ? asReversal(r) : asPrinted(r);
  });
}

/** R-2508: what a "check sign" line does to the account under each choice (for the buttons). */
export function signChoiceDirections(r: Pick<ParsedRow, "debit" | "credit">): {
  reversal: "in" | "out"; printed: "in" | "out"; amount: number; column: "Withdrawal" | "Deposit";
} {
  // The line is held as the reversal reading: a Withdrawal-column minus shows as a credit.
  return r.credit > 0
    ? { reversal: "in", printed: "out", amount: r.credit, column: "Withdrawal" }
    : { reversal: "out", printed: "in", amount: r.debit, column: "Deposit" };
}

/** The mark a reversal line's narration gets, so the owner sees why the money moved back. */
export const REVERSAL_MARK = " (reversal)";

/** R-2495: said in the preview, so a flipped line is never a silent change. */
const REVERSAL_PHRASE = "a negative amount — a reversal";
export function reversalWarning(n: number): string {
  return `${n} line${n === 1 ? " has" : "s have"} ${REVERSAL_PHRASE} (e.g. a failed ATM withdrawal) — and ${n === 1 ? "was" : "were"} read as the opposite side, marked "(reversal)". Check ${n === 1 ? "it" : "them"} in the preview.`;
}

/** R-2508: the warnings with ONE up-to-date reversal sentence for these rows (none when 0) — a
    line the owner settled as money out must not leave "1 line … reversal" behind. */
export function withReversalWarning(warnings: readonly string[], rows: readonly { reversal?: true; checkSign?: true }[]): string[] {
  const n = countReversals(rows);
  const rest = warnings.filter((w) => !w.includes(REVERSAL_PHRASE));
  return n > 0 ? [...rest, reversalWarning(n)] : rest;
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
function detectColumns(headerRow: string[]): Record<ColumnField, number> | null {
  const normalised = headerRow.map(normaliseHeader);
  const map: Partial<Record<ColumnField, number>> = {};

  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<[ColumnField, string[]]>) {
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
    /* R-2522: a separate Value Dt column only — a file whose one date column IS the value date
       already uses it as txn_date. */
    value_date:    map.value_date != null && map.value_date !== map.txn_date ? map.value_date : -1,
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
  let reversals = 0;
  const dateCol = mapping.txn_date;
  const order = detectDayOrder(raw.slice(headerIdx + 1).map((r) => r[dateCol] ?? ""));
  const amountsOf = (col: number) => (col >= 0 ? raw.slice(headerIdx + 1).map((r) => parseAmount(r[col])) : []);
  const signed = { debit: columnIsSigned(amountsOf(mapping.debit)), credit: columnIsSigned(amountsOf(mapping.credit)) };
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const r = raw[i];
    const date = parseDate(r[mapping.txn_date] ?? "", order);
    if (!date) { skipped++; continue; }
    // R-2495: a negative amount is a reversal — it moves to the other side. It was clamped to
    // 0 and skipped, which dropped a ₹20,000 ATM reversal and broke the balance check.
    const { debit, credit, reversal } = signedAmounts(
      mapping.debit  >= 0 ? parseAmount(r[mapping.debit])  : 0,
      mapping.credit >= 0 ? parseAmount(r[mapping.credit]) : 0,
      signed,
    );
    if (debit === 0 && credit === 0) { skipped++; continue; }
    // A bank line is debit XOR credit. If a row genuinely has both populated
    // (a mis-aligned column / reversal line), we can't tell which figure is
    // right — skip it rather than invent a number or fail the whole batch.
    if (debit > 0 && credit > 0) { skipped++; continue; }
    const description = (r[mapping.description] ?? "").trim() || "(no description)";
    /* R-2522: kept only when it differs from the txn date — the usual same-day value date says nothing. */
    const valueDate = mapping.value_date >= 0 ? parseDate(r[mapping.value_date] ?? "", order) : null;
    if (reversal) reversals++;
    /* R-2528: paise kept only when the printed figure has them (from the line's own column). */
    const dCell = mapping.debit >= 0 ? r[mapping.debit] : undefined;
    const cCell = mapping.credit >= 0 ? r[mapping.credit] : undefined;
    const amountPaise = Math.abs(parseAmount(dCell) !== 0 ? parseAmountPaise(dCell) : parseAmountPaise(cCell));
    const balanceAfter = mapping.balance_after >= 0 ? parseAmount(r[mapping.balance_after]) || null : null;
    const balancePaise = balanceAfter !== null ? parseAmountPaise(r[mapping.balance_after]) : null;
    out.push({
      txn_date:      date,
      description:   reversal ? description + REVERSAL_MARK : description,
      debit, credit,
      balance_after: balanceAfter,
      reference:     mapping.reference     >= 0 ? (r[mapping.reference]?.trim() || null)        : null,
      ...(valueDate && valueDate !== date ? { value_date: valueDate } : {}),
      ...(amountPaise !== (debit + credit) * 100 ? { amount_paise: amountPaise } : {}),
      ...(balancePaise !== null && balancePaise !== (balanceAfter as number) * 100 ? { balance_paise: balancePaise } : {}),
      ...(reversal ? { reversal: true as const } : {}),
    });
  }

  const warnings = order === "mdy"
    ? ["Dates in this file are written month first (MM/DD/YYYY) — read that way for every line. Check a few dates in the preview."]
    : [];
  /* R-2508: a reversal stays one only when the running balance agrees; otherwise "check sign". */
  const rows = reversals > 0 ? settleReversals(out) : out;
  const settled = countReversals(rows);
  if (settled > 0) warnings.push(reversalWarning(settled));
  return { rows, skipped, warnings };
}

/** CSV / "Delimited" text → lines. */
export function parseStatement(text: string): ParseResult {
  return parseStatementRows(parseCSV(text));
}
