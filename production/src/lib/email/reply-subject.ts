/**
 * The subject a REPLY must carry, so the customer's mail client keeps it in one conversation.
 *
 * ─── THE MAIL THAT ASKED FOR THIS ───────────────────────────────────────────
 * 31 Aug 2026. A real enquiry arrived with the whole request in the subject line:
 *
 *     "mujhe 32 email id ke liye quote chahiye google business starter"
 *
 * The app handled it well — lead created, product matched, quote Q-ADPL-2026-27-0055 drafted
 * at 32 seats, correctly NOT sent because the mail never said monthly or annual. It answered
 * within 13 seconds, and `email_log` recorded `provider gmail · status sent`.
 *
 * Pardeep never saw it. The agent had invented its own subject —
 *
 *     "Re: Google Workspace Business Starter quotation - Omega Co"
 *
 * — so Gmail did not group it with the thread he was looking at. The reply was sitting in his
 * inbox as a separate conversation. From where he sat, the app had simply not answered.
 *
 * A reply that lands outside its own thread is, for the person waiting, indistinguishable from
 * no reply at all. The model may write the body; it does not get to name the conversation.
 *
 * ─── WHAT THIS DOES NOT FIX ─────────────────────────────────────────────────
 * Gmail threads on `In-Reply-To` / `References` first and falls back to subject-and-
 * participants. `lib/email/send.ts` cannot set custom headers today (neither the Resend nor
 * the Gmail transport takes any), so this relies on the fallback. It is the cheap half of the
 * fix and the half that shows on screen; real header threading is a separate change to both
 * transports.
 */

/** Email subjects have no hard limit, but every client truncates. Keep it sane. */
export const MAX_SUBJECT = 200;

/**
 * Collapse the reply prefixes a thread accumulates.
 *
 * `Fwd:` is deliberately LEFT ALONE — a forwarded enquiry genuinely is a forward, and every
 * mail client answers it as "Re: Fwd: …". Only repeated `Re:` is noise.
 */
function stripReplyPrefixes(subject: string): string {
  let s = subject.trim();
  /* "Re:", "RE:", "re :", "Re[2]:", "Re(3):" — all of it, however many times. */
  for (;;) {
    const next = s.replace(/^re\s*(?:\[\d+\]|\(\d+\))?\s*:\s*/i, "");
    if (next === s) return s;
    s = next;
  }
}

/**
 * `Re: <the customer's own subject>`, or the model's subject when there is nothing to reply to.
 *
 * @param original what the customer wrote in their subject line
 * @param fallback the model's own `email_subject` — used only when `original` is empty, which
 *                 is the case for a channel that has no subject at all (WhatsApp)
 */
export function replySubject(
  original: string | null | undefined,
  fallback: string,
): string {
  const bare = stripReplyPrefixes(original ?? "");
  /* Nothing to thread to. The model's subject is then the best available, and it is what the
     app sent before this function existed. */
  if (!bare) return fallback.trim().slice(0, MAX_SUBJECT);

  const withPrefix = `Re: ${bare}`;
  if (withPrefix.length <= MAX_SUBJECT) return withPrefix;
  /* Truncate the SUBJECT, never the prefix: "Re:" is what does the threading.
     Budget: MAX minus "Re: " (4) minus the ellipsis (1). Getting that arithmetic wrong is
     what the length test caught on the first run — it returned 201. */
  return `Re: ${bare.slice(0, MAX_SUBJECT - 5).trimEnd()}…`;
}
