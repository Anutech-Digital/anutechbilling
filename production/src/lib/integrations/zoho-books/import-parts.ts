/**
 * R-1760 — "Import from Zoho" in parts.
 *
 * One Import of a real account (1,245 customers, 1,371 subscriptions, 246 open invoices) in a
 * single database call met the signed-in role's 8-second statement timeout and nothing was
 * imported. The import now goes part by part: zoho_books_import_begin() freezes the plan on
 * the run, then each zoho_books_import_step() call applies at most IMPORT_PART_ROWS rows of the
 * current stage (customers → subscriptions → invoices) in its own transaction. Measured on the
 * SQL test data (1,303 / 1,403 / 251): the slowest 150-row part took 248 ms.
 */

/** Rows per part. Measured 22 Oct: a 150-customer part ≈ 0.25 s against the 8 s timeout. */
export const IMPORT_PART_ROWS = 150;

export type ImportStage = "customers" | "subscriptions" | "invoices" | "done";
export const IMPORT_STAGES: readonly Exclude<ImportStage, "done">[] = ["customers", "subscriptions", "invoices"];

/** What zoho_books_import_begin / zoho_books_import_step answer. */
export interface ImportProgress {
  run_id: string;
  stage: ImportStage | null;
  offset: number;
  totals: Record<Exclude<ImportStage, "done">, number>;
  done: boolean;
  undo_started_at?: string | null;
  result: Record<string, unknown> | null;
}

const fmt = (n: number) => n.toLocaleString("en-IN");

/** How many calls an import of these totals takes (begin is not counted). */
export function countParts(totals: ImportProgress["totals"], size = IMPORT_PART_ROWS): number {
  const parts = IMPORT_STAGES.reduce((s, k) => s + Math.ceil(Math.max(0, totals[k] ?? 0) / size), 0);
  return Math.max(1, parts);
}

/** "Importing… 300 of 1,245 customers" — the stage the next part works on. */
export function importProgressText(p: Pick<ImportProgress, "stage" | "offset" | "totals" | "done">): string {
  if (p.done || p.stage === "done") return "Import finished";
  const stage = p.stage ?? "customers";
  const total = p.totals[stage] ?? 0;
  return `Importing… ${fmt(Math.min(p.offset, total))} of ${fmt(total)} ${stage}`;
}

/** 0–100 across the three stages, by rows. */
export function importPercent(p: Pick<ImportProgress, "stage" | "offset" | "totals" | "done">): number {
  if (p.done || p.stage === "done") return 100;
  const all = IMPORT_STAGES.reduce((s, k) => s + (p.totals[k] ?? 0), 0);
  if (all <= 0) return 0;
  const idx = IMPORT_STAGES.indexOf(p.stage ?? "customers");
  const before = IMPORT_STAGES.slice(0, Math.max(0, idx)).reduce((s, k) => s + (p.totals[k] ?? 0), 0);
  return Math.min(100, Math.round(((before + p.offset) / all) * 100));
}

/** R-1766: said when an undo call was cut off (statement timeout) — what was removed stays removed. */
export const UNDO_STOPPED_TEXT = "Undo stopped part way — press Undo import to continue.";

/** R-1766: what zoho_books_import_undo answers (totals from R-1766 on). */
export interface UndoProgress {
  subscriptions_removed?: number; subscriptions_total?: number;
  customers_removed?: number; customers_total?: number;
}

/** "Undoing… 300 of 1,371 subscriptions removed" — subscriptions go first, then customers. */
export function undoProgressText(r: UndoProgress): string {
  const subsTotal = r.subscriptions_total ?? 0;
  const subs = r.subscriptions_removed ?? 0;
  if (subsTotal > 0 && subs < subsTotal) return `Undoing… ${fmt(subs)} of ${fmt(subsTotal)} subscriptions removed`;
  const custTotal = r.customers_total ?? 0;
  if (custTotal > 0) return `Undoing… ${fmt(Math.min(r.customers_removed ?? 0, custTotal))} of ${fmt(custTotal)} customers removed`;
  return "Undoing…";
}
