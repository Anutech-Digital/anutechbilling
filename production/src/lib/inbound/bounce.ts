/**
 * A bounce is not an enquiry — it is news that OUR email did not arrive.
 *
 * ─── WHY THIS IS ITS OWN FILE ───────────────────────────────────────────────
 * Found 30 Aug 2026 on the live Enquiries screen: four "Delivery Status Notification
 * (Failure)" messages sitting at the top of the Inbox, under a page whose own subtitle
 * reads "what you still owe an answer on". They carried the badge **"ignored"** — the
 * raw database word, rendered because `inboundStatusMeta` had no case for it — and the
 * app offered a **"Send quote"** button, pointed at mailer-daemon@googlemail.com.
 *
 * The signal was exactly inverted. A bounce means a quote we sent never reached the
 * customer; ANUTECH's four all name `darshan@anutech.in`, an address that does not
 * exist, while the customer's real address is at democo. Someone was waiting
 * for a quote that had already failed to arrive, and the screen said "ignored".
 *
 * ─── WHY NOT REUSE `follow-up.ts`'S LIST ────────────────────────────────────
 * `AUTO_SUBJECTS` there is deliberately WIDER: it also holds "out of office" and
 * "automatic reply", because for deciding whether to raise a follow-up task, an OOO and
 * a bounce are the same answer — nobody is waiting. Here they are opposites. An
 * out-of-office means the mail ARRIVED and a human will read it on Monday. Reusing that
 * list would label every holiday auto-reply as a delivery failure, and a warning that
 * cries wolf is worse than no warning.
 *
 * ─── AND WHY NOT KEY OFF `status = 'ignored'` ───────────────────────────────
 * `routing.ts` writes `ignored` for ANY machine sender — a Google security alert from
 * no-reply@accounts.google.com lands there too. That is genuinely nothing to act on.
 * A bounce is something to act on. Same status, different news.
 */

export interface BounceCandidate {
  from_email: string | null;
  subject:    string | null;
  body_text?: string | null;
}

/** Local-parts that only a mail system uses. */
const BOUNCE_LOCALS = ["mailer-daemon", "postmaster", "bounce", "bounces"];

/**
 * Subjects that mean DELIVERY FAILED.
 *
 * "out of office" and "automatic reply" are deliberately absent — see the header.
 * "message blocked" IS here: Google sends it when the receiving server refuses the
 * mail, which is a failure to deliver however politely it is worded.
 */
const BOUNCE_SUBJECTS = [
  "delivery status notification", "undeliverable", "undelivered mail",
  "mail delivery failed", "mail delivery subsystem", "returned mail",
  "delivery has failed", "message blocked", "address not found",
  "delivery incomplete", "message not delivered",
];

const norm = (v: string | null | undefined): string => (v ?? "").toString().toLowerCase();

/** Did our own email fail to arrive? */
export function isBounce(row: BounceCandidate | null | undefined): boolean {
  if (!row) return false;

  const local = norm(row.from_email).split("@")[0] ?? "";
  if (BOUNCE_LOCALS.some((r) => local.includes(r))) return true;

  const subject = norm(row.subject);
  return BOUNCE_SUBJECTS.some((s) => subject.includes(s));
}

/**
 * Which address refused the mail, if the notice names one.
 *
 * ─── NULL RATHER THAN A GUESS ───────────────────────────────────────────────
 * A bounce body contains several addresses — the failed recipient, the sender, the
 * reporting mail server, and often a support URL. Picking "the first email-shaped
 * thing" would frequently name OUR OWN address as the one that failed, which sends a
 * rep to correct a record that is already right.
 *
 * So only the phrasings that explicitly say WHO it failed for are matched. When none
 * of them appear this returns null, and the UI says the address is not named — the
 * same rule the extraction panel already follows for a field it could not read.
 */
const FAILED_TO = [
  /* FIRST, because it is the only one that is not prose. RFC 3464 defines the
     delivery-status part of a bounce, and `Final-Recipient` is its machine-readable
     statement of who it failed for. ANUTECH's four live bounces all carry it:

         Final-Recipient: rfc822; darshan@anutech.in
         Action: failed
         Status: 5.1.3

     The English sentences below still earn their place — a bounce that reaches us as
     text/plain only, or from a server that words it differently, may have no
     delivery-status part at all. */
  /final-recipient:\s*(?:rfc822\s*;)?\s*([^\s<>,;()]+@[^\s<>,;()]+)/i,
  /wasn['’]?t delivered to\s+([^\s<>,;()]+@[^\s<>,;()]+)/i,
  /was not delivered to\s+([^\s<>,;()]+@[^\s<>,;()]+)/i,
  /delivery to the following recipients? failed[^\n]*[\s\S]{0,120}?([^\s<>,;()]+@[^\s<>,;()]+)/i,
  /failed permanently[\s\S]{0,120}?([^\s<>,;()]+@[^\s<>,;()]+)/i,
  /recipient address rejected[\s\S]{0,120}?([^\s<>,;()]+@[^\s<>,;()]+)/i,
  /<([^\s<>,;()]+@[^\s<>,;()]+)>:?\s*(?:host|recipient|address)/i,
];

export function bouncedAddress(row: BounceCandidate | null | undefined): string | null {
  const body = (row?.body_text ?? "").toString();
  if (!body) return null;

  for (const re of FAILED_TO) {
    const m = re.exec(body);
    /* Trailing punctuation is part of the sentence, not the address: "…to
       darshan@anutech.in because…" is fine, but "…to darshan@anutech.in." is not. */
    const hit = m?.[1]?.replace(/[.,;:]+$/, "").trim();
    if (hit && hit.includes("@")) return hit.toLowerCase();
  }
  return null;
}
