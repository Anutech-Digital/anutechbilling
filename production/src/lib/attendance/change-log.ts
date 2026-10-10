/**
 * R-608 — turn an attendance activity_log row into lines an owner can read.
 *
 * The trigger (20261010050000) stores `changes` as
 *   update: { <column>: { old, new }, ... }
 *   insert: { new: <whole row> }      delete: { old: <whole row> }
 * Only the columns that decide pay or tell a story are shown; ids and housekeeping are not.
 */
import { isoToIstHhmm } from "./ist-time";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json | undefined };

const SHOWN: Record<string, string> = {
  work_date: "Date",
  check_in: "Check-in",
  check_out: "Check-out",
  source: "Source",
  flags: "Flags",
  reviewed_at: "Reviewed",
  correction_note: "Note",
};

function show(key: string, v: Json | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  if ((key === "check_in" || key === "check_out") && typeof v === "string") {
    return isoToIstHhmm(v) || v;
  }
  if (key === "reviewed_at" && typeof v === "string") return "yes";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  return String(v);
}

export interface ChangeLine { field: string; before: string; after: string }

export function describeAttendanceChange(action: string, changes: Json | null): ChangeLine[] {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  const lines: ChangeLine[] = [];
  if (action === "update") {
    for (const [key, label] of Object.entries(SHOWN)) {
      const c = changes[key];
      if (c && typeof c === "object" && !Array.isArray(c)) {
        lines.push({ field: label, before: show(key, c.old), after: show(key, c.new) });
      }
    }
    return lines;
  }
  const row = action === "insert" ? changes.new : changes.old;
  if (!row || typeof row !== "object" || Array.isArray(row)) return [];
  for (const key of ["check_in", "check_out", "source"]) {
    const v = show(key, row[key]);
    lines.push(action === "insert"
      ? { field: SHOWN[key], before: "—", after: v }
      : { field: SHOWN[key], before: v, after: "—" });
  }
  // A day added through "Fix attendance" carries the owner's reason — show it.
  if (action === "insert" && typeof row.correction_note === "string" && row.correction_note.trim()) {
    lines.push({ field: SHOWN.correction_note, before: "—", after: row.correction_note.trim() });
  }
  return lines;
}
