/**
 * R-397 — "⚡ Urgent" on a bug report, after (or instead of) sending it to the AI.
 *
 * Pardeep, 7 Oct 2026: "AI ko bhej diya, baad me lage urgent karwana hai to kaise manage
 * karoge". The answer is one flag on the report (feedback.urgent_at / urgent_by, migration
 * 20261007234000_feedback_urgent.sql):
 *
 *   - an urgent report is handed out FIRST by /api/agent/feedback-queue, with `urgent: true`,
 *     so the AI worker / manager puts a worker on it before anything else;
 *   - pressing Urgent on an OPEN report also queues it (an urgent report that never reaches
 *     the AI is not urgent at all);
 *   - it can be taken back (un-urgent) — that only clears the flag, never un-queues.
 *
 * Who may press it is decided server-side in /api/feedback/urgent: the workspace owner or
 * manager (role + tenant read from the DB), or the platform owner for any workspace.
 *
 * Works BEFORE the migration: a row without the `urgent_at` key means "not ready", the
 * button is hidden and the queue order is unchanged.
 */
import { z } from "zod";
import { optionalColumn } from "./auto-send";

export const URGENT_AT_COLUMN = "urgent_at";
export const URGENT_BY_COLUMN = "urgent_by";
export const URGENT_MIGRATION = "20261007234000_feedback_urgent.sql";

/** Roles that may mark their own workspace's report urgent. */
export const URGENT_ROLES = ["owner", "manager"] as const;

export const urgentBody = z.object({ id: z.string().uuid(), urgent: z.boolean() });
export type UrgentBody = z.infer<typeof urgentBody>;

/** Statuses on which Urgent can be switched ON: open (it is queued too), queued, claimed. */
export const URGENT_STATUSES = ["open", "agent_queued"] as const;

export function mayMarkUrgent(role: string | null | undefined): boolean {
  return !!role && (URGENT_ROLES as readonly string[]).includes(role);
}

/** Has the migration been applied, as far as this row can tell? */
export function urgentReady(row: object | null | undefined): boolean {
  return !!row && URGENT_AT_COLUMN in row;
}

/** Is this report urgent? Missing column → no. */
export function isUrgent(row: object | null | undefined): boolean {
  const v = optionalColumn(row, URGENT_AT_COLUMN);
  return typeof v === "string" && v.length > 0;
}

/** May Urgent be switched ON for a report in this status? (OFF is always allowed.) */
export function canSetUrgent(status: string | null | undefined): boolean {
  return !!status && (URGENT_STATUSES as readonly string[]).includes(status);
}

/** A report row as the page holds it; urgent_at is absent before the migration. */
export type UrgentRowLike = { status: string; urgent_at?: string | null; agent_claimed_at?: string | null };

/** Should the toggle be drawn on this row? Ready, and either urgent (to take back) or eligible. */
export function showUrgentToggle(row: UrgentRowLike | null | undefined): boolean {
  if (!row || !urgentReady(row)) return false;
  return isUrgent(row) || canSetUrgent(row.status);
}

/** Columns written to switch urgent on or off — and nothing else. */
export function urgentPatch(on: boolean, callerId: string, now: string) {
  return on
    ? { [URGENT_AT_COLUMN]: now, [URGENT_BY_COLUMN]: callerId, updated_at: now }
    : { [URGENT_AT_COLUMN]: null, [URGENT_BY_COLUMN]: null, updated_at: now };
}

/** Urgent on an OPEN report also queues it — the same columns R-357/R-366 write. */
export function urgentQueuePatch(callerId: string, now: string) {
  return {
    status: "agent_queued" as const,
    dispatched_at: now,
    dispatched_by: callerId,
    ...urgentPatch(true, callerId, now),
  };
}

/**
 * The strip on an urgent report: "⚡ Urgent · AI worker has it · R-xxx". Open reports never
 * show it (Urgent queues them), so the middle part is always the queued/claimed wording.
 */
export function urgentLabel(card: string | null | undefined): string {
  return ["⚡ Urgent", "AI worker has it", card || null].filter(Boolean).join(" · ");
}

/**
 * Queue order: urgent first (earliest marked first), then the rest in the order given
 * (dispatched_at ascending from the DB). Stable — equal keys keep their input order.
 */
export function urgentFirst<T extends object>(rows: readonly T[]): T[] {
  return rows
    .map((r, i) => ({ r, i, at: isUrgent(r) ? String(optionalColumn(r, URGENT_AT_COLUMN)) : null }))
    .sort((a, b) => {
      if (a.at && b.at) return a.at < b.at ? -1 : a.at > b.at ? 1 : a.i - b.i;
      if (a.at) return -1;
      if (b.at) return 1;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/** Toast text after a press. */
export function urgentToast(on: boolean, queued: boolean): string {
  if (!on) return "No longer urgent.";
  return queued ? "Marked urgent and sent to the AI worker — top of its queue." : "Marked urgent — top of the AI worker's queue.";
}
