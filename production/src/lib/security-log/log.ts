/**
 * R-2350 (G-DPDP) — Settings → Security log: the pure part (filters, labels, CSV rows).
 *
 * Rows come from the database view `security_log`: customer / lead detail opens
 * (record_access_log) and every export (export_log, R-1006), owner of the company only.
 */
import { IST_TZ } from "@/lib/dates/ist";

export type SecurityRecordType = "customer" | "lead" | "export";

export interface SecurityLogRow {
  id: string;
  user_id: string | null;
  at: string;
  action: "view" | "export";
  record_type: SecurityRecordType;
  record_id: string | null;
  record_label: string | null;
  row_count: number | null;
  format: string | null;
}

export const SECURITY_LOG_COLUMNS = "id, user_id, at, action, record_type, record_id, record_label, row_count, format";

/** Rows read per filter — the newest first. */
export const SECURITY_LOG_LIMIT = 500;

export interface SecurityLogFilter {
  /** A user id, or "" for everyone. */
  userId: string;
  /** "" = all types. */
  recordType: "" | SecurityRecordType;
  /** IST calendar dates YYYY-MM-DD, "" = open-ended. */
  from: string;
  to: string;
}

export const EMPTY_FILTER: SecurityLogFilter = { userId: "", recordType: "", from: "", to: "" };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The day after an IST date, as YYYY-MM-DD (calendar maths in UTC, no DST in India). */
function nextDay(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/** The `at` range for a filter: from 00:00 IST of `from`, up to (not incl.) 00:00 IST after `to`. */
export function atRange(f: Pick<SecurityLogFilter, "from" | "to">): { gte?: string; lt?: string } {
  const out: { gte?: string; lt?: string } = {};
  if (ISO_DATE.test(f.from)) out.gte = `${f.from}T00:00:00+05:30`;
  if (ISO_DATE.test(f.to)) out.lt = `${nextDay(f.to)}T00:00:00+05:30`;
  return out;
}

export const RECORD_TYPE_LABEL: Record<SecurityRecordType, string> = {
  customer: "Customer",
  lead: "Lead",
  export: "Export",
};

export function actionLabel(r: Pick<SecurityLogRow, "action">): string {
  return r.action === "export" ? "Exported" : "Opened";
}

/** What was opened / exported, for a person to read. */
export function recordText(r: Pick<SecurityLogRow, "record_type" | "record_label" | "record_id">): string {
  if (r.record_label && r.record_label.trim()) return r.record_label.trim();
  if (r.record_type === "export") return "export";
  return "(deleted record)";
}

export function detailText(r: Pick<SecurityLogRow, "row_count" | "format">): string {
  if (r.row_count == null && !r.format) return "";
  const rows = r.row_count == null ? "" : `${r.row_count} row${r.row_count === 1 ? "" : "s"}`;
  return [rows, r.format ? r.format.toUpperCase() : ""].filter(Boolean).join(", ");
}

/** Where a row's record opens — null for exports and deleted records. */
export function recordHref(r: Pick<SecurityLogRow, "record_type" | "record_id" | "record_label">): string | null {
  if (!r.record_id || !r.record_label) return null;
  if (r.record_type === "customer") return `/customers/${encodeURIComponent(r.record_id)}`;
  if (r.record_type === "lead") return `/leads?lead=${encodeURIComponent(r.record_id)}`;
  return null;
}

/** 02 Nov 2026, 10:41 am — IST. */
export function whenText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: IST_TZ,
  });
}

export const CSV_HEADERS = ["When (IST)", "Person", "Action", "Type", "Record", "Details"];

export function csvRows(rows: readonly SecurityLogRow[], personOf: (userId: string | null) => string): string[][] {
  return rows.map((r) => [
    whenText(r.at),
    personOf(r.user_id),
    actionLabel(r),
    RECORD_TYPE_LABEL[r.record_type] ?? r.record_type,
    recordText(r),
    detailText(r),
  ]);
}
