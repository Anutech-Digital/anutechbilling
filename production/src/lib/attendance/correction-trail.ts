/**
 * R-439 — one owner correction (a row of public.attendance_corrections) → what the Fix
 * attendance dialog shows under "History for this day".
 *
 * The audit row is written by correct_attendance() in the same transaction as the change
 * (migration 20261011003000), so this list is the complete record of hand edits for a day.
 * Times are IST wall-clock (isoToIstHhmm) — never the browser's timezone.
 */
import { isoToIstHhmm } from "./ist-time";

export interface CorrectionRow {
  id: string;
  changed_at: string;
  changed_by: string | null;
  old_status: string;
  new_status: string;
  old_check_in: string | null;
  old_check_out: string | null;
  new_check_in: string | null;
  new_check_out: string | null;
  reason: string;
}

export interface TrailChange { field: "Status" | "Check-in" | "Check-out"; before: string; after: string }

const t = (iso: string | null) => (iso ? isoToIstHhmm(iso) || "—" : "—");
const word = (s: string) => (s === "present" ? "Present" : s === "absent" ? "Absent" : s);

/** Only what actually changed. A status change says so and leaves the times out when the day
 *  became absent (the times went with it). An unchanged re-save returns []. */
export function describeCorrection(r: CorrectionRow): TrailChange[] {
  const out: TrailChange[] = [];
  if (r.old_status !== r.new_status) out.push({ field: "Status", before: word(r.old_status), after: word(r.new_status) });
  if (r.new_status === "absent") return out;
  if (t(r.old_check_in) !== t(r.new_check_in)) out.push({ field: "Check-in", before: t(r.old_check_in), after: t(r.new_check_in) });
  if (t(r.old_check_out) !== t(r.new_check_out)) out.push({ field: "Check-out", before: t(r.old_check_out), after: t(r.new_check_out) });
  return out;
}

/** Newest first; ties by id so the order is stable. */
export function sortTrail<T extends Pick<CorrectionRow, "changed_at" | "id">>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.changed_at.localeCompare(a.changed_at) || b.id.localeCompare(a.id));
}
