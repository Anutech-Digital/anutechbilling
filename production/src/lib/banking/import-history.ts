/**
 * R-1623 — a bank account's statement imports, as the account page's "Imports" list shows them.
 *
 * Rows come from the DB function bank_import_history(): every Import click since R-1623 is a
 * batch (bank_import_batches; its lines carry import_batch_id), and the lines imported BEFORE
 * batches existed are grouped into "old imports" by insert time — one import was one insert,
 * so its lines share a created_at, and a gap of more than 60 seconds starts the next one.
 *
 * Pure helpers only (no React, no client): which lines an import owns, which of them block
 * "Ye import hatao", what the removal sends, and whether the import clashes with the
 * account's running-balance chain.
 */
import { checkStatement } from "@/lib/banking/statement-check";

export type BankImportSource = "pdf" | "csv" | "xlsx" | "paste" | "image" | "legacy";

/** One row of bank_import_history(). */
export type BankImportRow = {
  kind: "batch" | "legacy";
  batch_id: string | null;
  /** Old imports only: the exact insert-time range (microseconds), sent back unchanged to remove it. */
  legacy_from: string | null;
  legacy_to: string | null;
  file_name: string | null;
  source: BankImportSource | string;
  line_count: number;
  imported_at: string;
  imported_by: string | null;
  txn_from: string | null;
  txn_to: string | null;
  first_balance: number | null;
  last_balance: number | null;
  reconciled_count: number;
  removed_at: string | null;
  removed_by: string | null;
  remove_reason: string | null;
  removed_lines: number | null;
};

/** The bank-line fields these helpers read. */
export type ImportLine = {
  id: string;
  txn_date: string;
  debit: number;
  credit: number;
  balance_after: number | null;
  matched_to_type: string | null;
  import_batch_id?: string | null;
  source: string;
  created_at: string;
  description: string;
};

export function importKey(r: BankImportRow): string {
  return r.kind === "batch" ? `batch:${r.batch_id}` : `legacy:${r.legacy_from}`;
}

/** A timestamp as whole milliseconds. Postgres sends microseconds; both sides lose the same
 *  digits, so an inclusive range test stays exact (imports are > 60 s apart). */
function ms(ts: string): number {
  return Date.parse(ts.replace(/(\.\d{3})\d+/, "$1"));
}

export function linesOfImport<L extends ImportLine>(r: BankImportRow, lines: L[]): L[] {
  if (r.removed_at) return [];
  if (r.kind === "batch") return lines.filter((l) => l.import_batch_id === r.batch_id);
  if (!r.legacy_from || !r.legacy_to) return [];
  const from = ms(r.legacy_from);
  const to = ms(r.legacy_to);
  return lines.filter((l) => !l.import_batch_id && l.source === "csv_upload"
    && ms(l.created_at) >= from && ms(l.created_at) <= to);
}

/** The import's lines that are reconciled — "N of this import's lines are reconciled — un-reconcile them first". */
export function reconciledLinesOf<L extends ImportLine>(r: BankImportRow, lines: L[]): L[] {
  return linesOfImport(r, lines).filter((l) => l.matched_to_type !== null);
}

export type RemoveImportArgs = {
  p_account_id: string;
  p_batch_id: string | null;
  p_legacy_from: string | null;
  p_legacy_to: string | null;
  p_reason: string;
};

export function removeImportArgs(r: BankImportRow, accountId: string, reason: string): RemoveImportArgs {
  return {
    p_account_id: accountId,
    p_batch_id: r.kind === "batch" ? r.batch_id : null,
    p_legacy_from: r.kind === "legacy" ? r.legacy_from : null,
    p_legacy_to: r.kind === "legacy" ? r.legacy_to : null,
    p_reason: reason.trim(),
  };
}

/** Newest first; at the same time a live import before a removed one. */
export function sortImports(rows: BankImportRow[]): BankImportRow[] {
  return [...rows].sort((a, b) => {
    const d = ms(b.imported_at) - ms(a.imported_at);
    if (d !== 0) return d;
    return (a.removed_at ? 1 : 0) - (b.removed_at ? 1 : 0);
  });
}

export function sourceLabel(source: string): string {
  switch (source) {
    case "pdf": return "PDF";
    case "csv": return "CSV";
    case "xlsx": return "XLS / XLSX";
    case "paste": return "Pasted";
    case "image": return "Photo";
    case "legacy": return "Old import";
    default: return source;
  }
}

/**
 * "Lines missing" (the Statement check's gap total) with every line, and without this
 * import's lines. When removing the import makes the gap smaller, its balances do not chain
 * with the rest of the account. null when the statement carries no running balance — then
 * there is nothing to say.
 */
export function chainEffect(all: ImportLine[], importLines: ImportLine[], openingBalance: number): { before: number; after: number } | null {
  const gapTotal = (ls: ImportLine[]) => {
    const c = checkStatement(ls, openingBalance);
    return c ? c.gaps.reduce((s, g) => s + Math.abs(g.amount), 0) : null;
  };
  const before = gapTotal(all);
  if (before === null) return null;
  const drop = new Set(importLines.map((l) => l.id));
  const rest = all.filter((l) => !drop.has(l.id));
  const after = rest.length ? gapTotal(rest) ?? 0 : 0;
  return { before, after };
}
