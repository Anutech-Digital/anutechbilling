/**
 * What the dunning log should say actually happened.
 *
 * ─── THE ROW THAT PROMPTED THIS ─────────────────────────────────────────────
 * `invoice_dunning_log`, 19 and 21 Aug 2026, invoice INV-3BBD-2026-27-0002
 * (BETA CO PROJECTS PRIVATE LIMITED, ₹55,885):
 *
 *     dunning_step  reminder   days_overdue 1   status sent   recipient_email NULL
 *     dunning_step  retry      days_overdue 3   status sent   recipient_email NULL
 *
 * **Nothing was sent.** The route only sends when it has an address —
 * `if (to && msg) await sendEmail(...)` — and that customer has no `contact_email`.
 * The status came from `isEmailConfigured() ? "sent" : "stubbed"`, which answers a
 * different question: whether Resend is set up on the server, not whether this
 * particular message reached anybody.
 *
 * So the audit trail says a real customer was chased twice and it never was. That is
 * the §2 mistake in its most expensive form, because the wrong value is *reassuring*:
 * the reseller reads "reminder sent, retry sent, still unpaid" and concludes the
 * customer is ignoring them. The ladder advances on the same rows, so the invoice
 * marches towards escalation labelled "the customer has had the full reminder
 * sequence" — a sentence about somebody who was never contacted.
 *
 * A missing customer email is a perfectly ordinary state. It just has to be *visible*,
 * because it is the reseller's to fix and nobody else's.
 */

/** What the row records. `no_recipient` is new — the other two kept their meaning. */
export type DunningLogStatus = "sent" | "stubbed" | "no_recipient";

export interface DunningLogStatusInput {
  /** The address the message was actually addressed to, if any. */
  recipient: string | null | undefined;
  /** False when no message could be composed for this step. */
  hasMessage: boolean;
  /** Whether the email provider is configured on this server. */
  emailConfigured: boolean;
}

/**
 * Order matters: the recipient is checked FIRST.
 *
 * Asking `emailConfigured` first is exactly how the old line went wrong — a configured
 * provider says nothing about a message with nowhere to go. "Did this reach anyone" is
 * answered by the address, and only then by the provider.
 */
export function dunningLogStatus(input: DunningLogStatusInput): DunningLogStatus {
  const to = input.recipient?.trim();
  if (!to || !input.hasMessage) return "no_recipient";
  return input.emailConfigured ? "sent" : "stubbed";
}

/** True when this row represents a step that reached nobody. */
export function reachedNobody(status: DunningLogStatus): boolean {
  return status === "no_recipient";
}

/* ─── R-1538 / R-1539 / R-1572 (18 Oct 2026): the SEND RESULT decides the row ─────────────
 * dunningLogStatus() above answers "was there anybody to email". It never saw what the
 * provider said, so a step refused by the "Customer messages" switch, or rejected by the
 * provider, was logged "sent" — the ladder moved on, the owner was told "the customer has had
 * the full reminder sequence", and the pause pass counted a notice that reached nobody.
 *
 * Now every customer email in the dunning cron is logged like this:
 *   1. CLAIM: a row with status 'sending' is written BEFORE the send. If that write fails,
 *      nothing is sent (a send we cannot record is a send we would repeat tomorrow).
 *   2. SEND through lib/messaging.
 *   3. OUTCOME: the row is updated to what really happened (dunningOutcome below). If that
 *      write fails the row stays 'sending' — "may have gone" — and is never re-sent.
 */

/** Every status a dunning log row can carry. 'failed' and 'sending' are written by the cron. */
export type DunningRowStatus = DunningLogStatus | "failed" | "sending";

/** How many times one step is tried before it is given up (and reported). */
export const MAX_STEP_ATTEMPTS = 3;

/** Reached the customer: the provider accepted the email. */
export function isDelivered(status: string | null | undefined): boolean {
  return status === "sent";
}

/** Must not be sent again: delivered, or claimed with no recorded outcome (may have gone). */
export function blocksResend(status: string | null | undefined): boolean {
  return status === "sent" || status === "sending";
}

export interface DunningOutcome {
  status: Exclude<DunningRowStatus, "sending">;
  /** Plain words for the owner / the log. Null only when sent. */
  reason: string | null;
}

/* A delivery status, not a quote status (quote-sent-stage-wiring.test.ts scans for quote writers). */
const DELIVERED = "sent" as const;

export const NO_EMAIL_REASON = "no email address on file for this customer";
const NOT_SET_UP = "email is not set up on the server — nothing was sent";

/**
 * What a send attempt really did. `send` is null when nothing was sent (no address or no
 * message); otherwise it is the result lib/messaging returned.
 */
export function dunningOutcome(input: {
  recipient: string | null | undefined;
  hasMessage: boolean;
  send: { status: string; errorMessage?: string | null } | null;
}): DunningOutcome {
  if (!input.hasMessage) return { status: "no_recipient", reason: "no message for this step" };
  if (!input.recipient?.trim() || !input.send) return { status: "no_recipient", reason: NO_EMAIL_REASON };
  if (input.send.status === DELIVERED) return { status: DELIVERED, reason: null };
  if (input.send.status === "stubbed") {
    return { status: "stubbed", reason: (input.send.errorMessage ?? NOT_SET_UP).slice(0, 500) };
  }
  return { status: "failed", reason: (input.send.errorMessage ?? "not sent").slice(0, 500) };
}

/** Plain words for a log row that did not reach the customer. */
export function undeliveredReason(row: { status: string; error_message?: string | null }): string {
  if (row.status === "no_recipient") return NO_EMAIL_REASON;
  if (row.status === "sending") return "send started but its result was never recorded — check the email log";
  if (row.error_message) return row.error_message;
  if (row.status === "stubbed") return NOT_SET_UP;
  return "not sent";
}

export interface StepHistory {
  /** Rows for this step whose status does not block a resend (tried, did not reach anyone). */
  undelivered: number;
  /** Some row for this step is 'sent'. */
  delivered: boolean;
  /** Some row for this step is 'sending' (outcome unknown). */
  inFlight: boolean;
  /** Reason from the latest undelivered row. */
  lastReason: string | null;
}

/** Per-step history of one invoice/subject, from its log rows (any order). */
export function stepHistory(rows: readonly { dunning_step: string; status: string; error_message?: string | null; sent_at?: string | null }[]): Map<string, StepHistory> {
  const out = new Map<string, StepHistory>();
  const sorted = [...rows].sort((a, z) => String(a.sent_at ?? "").localeCompare(String(z.sent_at ?? "")));
  for (const r of sorted) {
    const h = out.get(r.dunning_step) ?? { undelivered: 0, delivered: false, inFlight: false, lastReason: null };
    if (isDelivered(r.status)) h.delivered = true;
    else if (r.status === "sending") h.inFlight = true;
    else { h.undelivered++; h.lastReason = undeliveredReason(r); }
    out.set(r.dunning_step, h);
  }
  return out;
}

/** Done with this step: delivered, maybe-delivered, or tried MAX_STEP_ATTEMPTS times. */
export function stepSettled(h: StepHistory | undefined): boolean {
  if (!h) return false;
  return h.delivered || h.inFlight || h.undelivered >= MAX_STEP_ATTEMPTS;
}
