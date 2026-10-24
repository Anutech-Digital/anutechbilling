/**
 * R-1006 — record every export: who downloaded what, how many rows, which format.
 *
 * WHY: nothing recorded a CSV of the customer list or the salary register leaving the app. A
 * departing employee could take the whole book of business and leave no trace. Every export
 * button now writes one `export_log` row through the database function `log_export()`, which
 * takes the company from the session (current_tenant_id()), never from the browser — so a row
 * can never be written for another company. Only the company owner can read the log (RLS).
 *
 * THE ONE RULE: logging must never stop an export. `logExport` never throws and never
 * rejects; a failed write is a console warning, and the file still downloads.
 *
 * Every download in src/ goes through here — `downloadCSV` in lib/csv calls it for you; a
 * screen that builds its own Blob calls `logExport` next to its `a.download`. The scan test
 * (export-log-scan.test.ts) fails when a new download is added without it.
 */

export type ExportFormat = "csv" | "xlsx" | "pdf" | "json" | "xml" | "txt";

export interface ExportMeta {
  /** Report / table key, e.g. "customers", "salary-register". Dates in it are fine — they are stripped. */
  what: string;
  /** Data rows in the file (header not counted). */
  rowCount: number;
  format: ExportFormat;
}

/** What the database call resolves to — the only part read. */
type RpcResult = { error: { message?: string } | null };
export type ExportLogWriter = (args: { p_what: string; p_row_count: number; p_format: string }) => PromiseLike<RpcResult>;

/** 2026-04-01, 20260401, 2026-04 (a month), 202604 (ECR month) — never part of a report's name. */
const DATE = /\d{4}-\d{2}-\d{2}|(?<!\d)20\d{6}(?!\d)|(?<!\d)20\d{2}-(?:0[1-9]|1[0-2])(?!\d)|(?<!\d)20\d{2}(?:0[1-9]|1[0-2])(?!\d)/g;

/**
 * A stable report key from a download filename: `day-book-2026-04-01-to-2026-04-30.csv` →
 * `day-book`. Dates, the extension and trailing joiner words are dropped so the owner sees the
 * same key for every run of the same report; anything else (a bank account name, a party) stays,
 * because WHICH account was exported is part of the answer.
 */
export function exportKey(filename: string): string {
  const key = filename
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(DATE, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-(to|from|on)(?=-|$)/gi, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 200);
  return key || "export";
}

/**
 * Rows in a JSON export (a backup snapshot): every array at the top level or one level down
 * counts its items — `{ tables: { customers: [..], invoices: [..] } }` and `{ customers: [..] }`
 * both count the records. A bare array counts itself.
 */
export function countJsonRows(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (!data || typeof data !== "object") return 0;
  let n = 0;
  for (const v of Object.values(data)) {
    if (Array.isArray(v)) n += v.length;
    else if (v && typeof v === "object") {
      for (const w of Object.values(v)) if (Array.isArray(w)) n += w.length;
    }
  }
  return n;
}

async function defaultWriter(args: Parameters<ExportLogWriter>[0]): Promise<RpcResult> {
  // Lazy: lib/csv (which calls this) is also imported by server code and node tests.
  const { createClient } = await import("@/lib/supabase/client");
  return await createClient().rpc("log_export", args);
}

/**
 * Write one export_log row. Never throws, never rejects — call it without awaiting
 * (`void logExport(...)`) right where the file is handed to the browser.
 */
export async function logExport(meta: ExportMeta, writer: ExportLogWriter = defaultWriter): Promise<void> {
  try {
    const rows = Number.isFinite(meta.rowCount) ? Math.max(0, Math.trunc(meta.rowCount)) : 0;
    const { error } = await writer({ p_what: exportKey(meta.what), p_row_count: rows, p_format: meta.format });
    if (error) console.warn(`[export-log] could not record export "${meta.what}": ${error.message ?? "unknown error"}`);
  } catch (e) {
    console.warn(`[export-log] could not record export "${meta.what}": ${e instanceof Error ? e.message : String(e)}`);
  }
}
