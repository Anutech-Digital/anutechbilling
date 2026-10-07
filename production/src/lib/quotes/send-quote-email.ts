/**
 * R-408 — the ONE client path that emails a quote.
 *
 * Abhishek's audit, 7 Oct 2026: the builder's big "Save & send quote" button only set
 * status = 'sent'. No email went (Q-DEMO-27-0001: status sent, email_log 0), yet the owner
 * reasonably believed the customer had the quote. The only real send was the separate
 * "Send via email" sheet, which POSTs to /api/quotes/[id]/send.
 *
 * Both now call `sendQuoteEmail` below, so there is one path and no copy that can drift.
 * The route renders the PDF, sends through lib/email/send.ts (which writes `email_log`),
 * logs `quote_send_log`, and flips draft → sent ONLY when the mail went (or was stubbed).
 *
 * `saveAndSendPlan` decides what the builder's main button does, `saveAndSendLabel` names
 * it honestly, and `quoteEmailOutcome` turns the route's answer into plain toast copy.
 */
export interface SendQuoteEmailInput {
  /** Recipient. Omit to let the server use the customer's primary contact. */
  to?: string | null;
  subject?: string | null;
  message?: string | null;
}

/** Delivery status of the email (lib/email/send.ts), not a quote status. */
export type EmailDeliveryStatus = "sent" | "stubbed" | "failed";

export interface SendQuoteEmailResult {
  status:       EmailDeliveryStatus;
  email_mode:   "real" | "stub";
  providerId:   string | null;
  errorMessage: string | null;
  recipient:    string;
  attachedPdf:  boolean;
  quoteStatus:  string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** POST /api/quotes/[id]/send. Throws with the server's own words on a non-2xx. */
export async function sendQuoteEmail(
  quoteId: string,
  input: SendQuoteEmailInput = {},
  fetchImpl: FetchLike = fetch,
): Promise<SendQuoteEmailResult> {
  const res = await fetchImpl(`/api/quotes/${encodeURIComponent(quoteId)}/send`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      to:      input.to?.trim() || undefined,
      subject: input.subject?.trim() || undefined,
      message: input.message?.trim() || undefined,
    }),
  });
  let json: Partial<SendQuoteEmailResult> & { error?: string } = {};
  try { json = await res.json(); } catch { /* non-JSON body — handled below */ }
  if (!res.ok) throw new Error(json.error ?? `Send failed (${res.status})`);
  return json as SendQuoteEmailResult;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The address the builder would send to, or null when there is none worth trying. */
export function quoteRecipient(email: string | null | undefined): string | null {
  const e = (email ?? "").trim();
  return EMAIL_RE.test(e) ? e : null;
}

/**
 * What "Save & send" does.
 *  - "email"          → save, then email through sendQuoteEmail.
 *  - "mark-sent"      → no email address: save as sent and SAY no email went.
 *  - "needs-approval" → discount/margin needs sign-off: save as draft, email nothing.
 *    Emailing an unapproved discount would hand the customer a price nobody cleared.
 */
export type SaveAndSendPlan = "email" | "mark-sent" | "needs-approval";

export function saveAndSendPlan(args: {
  recipient: string | null;
  /** canSend(...).allowed from lib/quotes/approval — the same gate the detail page uses. */
  sendAllowed: boolean;
}): SaveAndSendPlan {
  if (!args.sendAllowed) return "needs-approval";
  return args.recipient ? "email" : "mark-sent";
}

/** Button text. It must not promise an email it will not send. */
export function saveAndSendLabel(plan: SaveAndSendPlan): { full: string; short: string } {
  if (plan === "mark-sent") return { full: "Save & mark sent", short: "Mark sent" };
  return { full: "Save & send quote", short: "Save & send" };
}

export interface Outcome {
  ok: boolean;
  title: string;
  description?: string;
}

/** Toast copy for the route's answer. `ok` false means the quote was NOT emailed. */
export function quoteEmailOutcome(
  res: SendQuoteEmailResult,
  opts: { quoteId: string; alreadySent?: boolean },
): Outcome {
  if (res.status === "sent") {
    return {
      ok: true,
      title: `${opts.alreadySent ? "Quote resent" : "Quote sent"} to ${res.recipient}`,
      description: res.attachedPdf ? "PDF attached." : undefined,
    };
  }
  if (res.status === "stubbed") {
    return {
      ok: true,
      title: `${opts.quoteId} logged — no real email (test mode)`,
      description: "Email delivery is not set up on this server.",
    };
  }
  return {
    ok: false,
    title: `Email did not go to ${res.recipient}`,
    description: `${res.errorMessage ?? "Unknown error"}. ${notSentTail(opts.alreadySent)}`,
  };
}

/** Toast copy when the request itself failed (network, 4xx/5xx). */
export function quoteEmailErrorOutcome(err: unknown, opts: { alreadySent?: boolean } = {}): Outcome {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    title: "Email did not go",
    description: `${msg}. ${notSentTail(opts.alreadySent)}`,
  };
}

function notSentTail(alreadySent?: boolean): string {
  return alreadySent ? "Nothing was sent — try again." : "The quote is saved as a draft — try again.";
}

/** Toast copy for the no-email case. */
export function markedSentOutcome(quoteId: string): Outcome {
  return {
    ok: true,
    title: `${quoteId} marked sent — no email went`,
    description: "The customer has no email. Add one, then use Send via email, or share it on WhatsApp.",
  };
}

/** Toast copy for the needs-approval case. */
export function needsApprovalOutcome(quoteId: string): Outcome {
  return {
    ok: true,
    title: `${quoteId} saved as draft — needs approval first`,
    description: "Nothing was emailed. Send it once it is approved.",
  };
}
