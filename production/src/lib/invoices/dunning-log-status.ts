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
