/**
 * R-2243 (Zoho Billing study, idea 2): why a customer leaves — ONE fixed reason list for both
 * "Cancel subscription" and "Won't renew", so the owner can count it ("5 left on price this year").
 *
 * Before, the reason was free text only (5+ characters) and could not be counted. The code is
 * stored once, in subscriptions.leave_reason_code (migration 20261117…_r2243_leave_reason);
 * the free-text columns (cancel_reason / non_renew_reason) keep the readable sentence, so every
 * place that already shows the reason keeps working. Rows from before this card have no code and
 * read "Not recorded". Keep LEAVE_REASONS in step with `subscriptions_leave_reason_code_check`.
 *
 * Pure (no React, no DB) so the list, the check and the count are unit-tested.
 */

export type LeaveReasonCode =
  | "price" | "competitor" | "other_suite" | "closed" | "downsized" | "not_using" | "payment" | "other";

export interface LeaveReason {
  code: LeaveReasonCode;
  /** The picklist text — short, as the owner would say it. */
  label: string;
}

/** Order = the order in the picklist (most common first). */
export const LEAVE_REASONS: readonly LeaveReason[] = [
  { code: "price",       label: "Price too high" },
  { code: "competitor",  label: "Moved to another provider" },
  { code: "other_suite", label: "Moved to Microsoft 365 / other suite" },
  { code: "closed",      label: "Business closed" },
  { code: "downsized",   label: "Fewer users / downsizing" },
  { code: "not_using",   label: "Not using it" },
  { code: "payment",     label: "Payment problems" },
  { code: "other",       label: "Other" },
] as const;

/** Shown for rows that have no code (cancelled before R-2243). */
export const NOT_RECORDED = "Not recorded";

/** "Other" needs a note of at least this many characters (the server applies the same rule). */
export const OTHER_NOTE_MIN = 5;

const CODES = new Set<string>(LEAVE_REASONS.map((r) => r.code));

export function isLeaveReason(v: unknown): v is LeaveReasonCode {
  return typeof v === "string" && CODES.has(v);
}

/** Label for a stored code. Missing or unknown gives "Not recorded". */
export function leaveReasonLabel(code: string | null | undefined): string {
  const hit = LEAVE_REASONS.find((r) => r.code === code);
  return hit ? hit.label : NOT_RECORDED;
}

/** The dialog's check — null when the reason may be saved. A reason is required; "Other" needs a note. */
export function leaveReasonInputError(i: { code: string; note: string }): string | null {
  if (!isLeaveReason(i.code)) return "Pick why the customer is leaving.";
  if (i.code === "other" && i.note.trim().length < OTHER_NOTE_MIN) {
    return `Write a short note for “Other” (at least ${OTHER_NOTE_MIN} characters).`;
  }
  return null;
}

/** The sentence kept in the existing free-text column: "Price too high — they found it cheaper". */
export function leaveReasonText(code: LeaveReasonCode, note: string): string {
  const n = note.trim();
  return n ? `${leaveReasonLabel(code)} — ${n}` : leaveReasonLabel(code);
}

export interface LeaverRow {
  status?: string | null;
  auto_renew?: boolean | null;
  cancelled_at?: string | null;
  non_renew_set_at?: string | null;
  leave_reason_code?: string | null;
}

/** The day a subscription was marked as leaving, or null when it is not leaving / has no date. */
export function leftAt(r: LeaverRow): string | null {
  if (r.status === "cancelled") return r.cancelled_at ?? null;
  if (r.auto_renew === false) return r.non_renew_set_at ?? null;   // Won't renew (still running, or already lapsed)
  return null;
}

export interface LeaveReasonCount {
  code: LeaveReasonCode | "unrecorded";
  label: string;
  count: number;
  /** Share of all leavers in the window, 0-100, rounded. */
  pct: number;
}

/**
 * "Why customers leave" — leavers in the last 12 months grouped by reason, biggest first, "Not recorded"
 * (no code, i.e. before R-2243) shown honestly and last. A subscription is counted once, on the day it
 * was cancelled or marked Won't renew.
 */
export function leaveReasonCounts(
  rows: ReadonlyArray<LeaverRow>,
  now: Date = new Date(),
): { total: number; rows: LeaveReasonCount[] } {
  const from = new Date(now);
  from.setFullYear(from.getFullYear() - 1);
  const acc = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const at = leftAt(r);
    if (!at) continue;
    const t = new Date(at).getTime();
    if (Number.isNaN(t) || t < from.getTime() || t > now.getTime() + 86_400_000) continue;
    const key = isLeaveReason(r.leave_reason_code) ? r.leave_reason_code : "unrecorded";
    acc.set(key, (acc.get(key) ?? 0) + 1);
    total += 1;
  }
  const out = [...acc.entries()].map(([code, count]) => ({
    code: code as LeaveReasonCount["code"],
    label: code === "unrecorded" ? NOT_RECORDED : leaveReasonLabel(code),
    count,
    pct: total > 0 ? Math.round((count / total) * 100) : 0,
  }));
  out.sort((a, b) => (a.code === "unrecorded" ? 1 : 0) - (b.code === "unrecorded" ? 1 : 0) || b.count - a.count);
  return { total, rows: out };
}
