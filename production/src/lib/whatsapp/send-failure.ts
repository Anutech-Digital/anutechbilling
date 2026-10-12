/**
 * Turning a WhatsApp send failure into the right HTTP answer.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * `/api/whatsapp/send` mapped **every** throw to `502` in one catch-all. So on
 * 12 Aug 2026 a workspace that simply had not filled in its WhatsApp credentials
 * produced this, in Cloud Run's ERROR bucket:
 *
 *     502  [/api/whatsapp/send] failed: WhatsApp credentials are not configured
 *          for this workspace. Settings → Integrations → WhatsApp Business.
 *
 * Two things wrong with that, and the first is the expensive one:
 *
 * 1. **It is not a server error, so it must not be logged as one.** Production had
 *    four 5xx events in the fortnight to 22 Aug; this was one of them. A settings
 *    page nobody filled in was sitting in the same bucket as a lost backup,
 *    diluting the only signal anybody scans. An error log that carries
 *    configuration notices stops being read as errors.
 * 2. **502 means "try again, the upstream is unwell".** Nothing here will change on
 *    a retry — Meta was never called. The client cannot fix a 502; it can fix a
 *    409, and the message already says exactly where to go (CLAUDE.md §24).
 *
 * A genuine Meta or network failure is **still a 502**. That is the whole point:
 * classify, do not lump. Same shape as `lib/backup/sweep-retry.ts` and
 * `lib/email/gmail-transport.ts`.
 */

/**
 * The tenant has not set up WhatsApp. Thrown by `sendWhatsApp` before any network
 * call, and the one failure on this path that is the caller's to fix.
 */
export class WhatsAppNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppNotConfiguredError";
  }
}

export interface SendFailureResponse {
  status: number;
  /** Which console channel this belongs in. Only a real fault earns "error". */
  level: "warn" | "error";
  message: string;
}

/**
 * Map a thrown send failure to its status and log level.
 *
 * `instanceof` is checked first, but the message is checked too: the error crosses
 * a module boundary and, if this path is ever reached through a re-thrown or
 * structured-cloned error, `instanceof` quietly stops holding while the message
 * survives. A prototype chain is a worse thing to hang a status code on than the
 * sentence a human wrote.
 */
export function classifySendFailure(err: unknown): SendFailureResponse {
  const message = err instanceof Error ? err.message : String(err);

  const notConfigured =
    err instanceof WhatsAppNotConfiguredError ||
    /credentials are not configured/i.test(message);

  if (notConfigured) {
    return { status: 409, level: "warn", message };
  }

  /* R-897: the owner has "Customer messages" (or this job) switched off in Automation — a
     setting, not an outage. Same reasoning as above: the owner can fix it, a retry cannot. */
  const refused =
    (err instanceof Error && err.name === "CustomerMessageRefusedError") ||
    /customer messages are switched off|is not on for this company/i.test(message);
  if (refused) {
    return { status: 409, level: "warn", message };
  }

  return { status: 502, level: "error", message };
}
