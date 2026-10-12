/**
 * Does this inbound email deserve a follow-up task?
 *
 * The inbound webhook already asks Gemini `{ isEnquiry, company, contactName,
 * phone, product, summary }` and writes one of `lead_created`,
 * `appended_to_lead` or `skipped_non_enquiry`. That judgement works — measured
 * against the 9 real rows in production, a Google "Security alert" from
 * no-reply@accounts.google.com is correctly skipped while a genuine
 * "Need Microsoft 365 for 25 users" becomes a lead.
 *
 * What was missing is the task. This decides whether to create one, when it is
 * due, and how urgent — and it is a separate, pure function rather than more
 * prompt text for two reasons.
 *
 * ─── 1. THE AI MUST NOT BE ABLE TO CREATE A TASK FOR AN AUTO-REPLY ───────────
 * `extractWithGemini` returns null on ANY failure — timeout, quota, malformed
 * JSON — and the webhook then defaults to `isEnquiry: true`, deliberately, so a
 * real enquiry is never silently dropped. That default is right for lead
 * creation and wrong for task creation: on a bad Gemini day it would put an
 * "Out of office" bounce and every Google security alert on someone's task list,
 * and a task list that fills with rubbish stops being read at all.
 *
 * So the hard suppressions below run FIRST and cannot be overridden by the model.
 * The AI decides how interesting a real email is; it does not get to decide that
 * a delivery-failure notice is a sales conversation.
 *
 * ─── 2. AI OUTPUT CANNOT BE REGRESSION-TESTED ────────────────────────────────
 * "Gemini said yes" is not something a test can assert next month. The rules
 * here can be, and they are the part that decides whether a person's day gets
 * interrupted.
 *
 * ─── WHAT IS DELIBERATELY *NOT* SUPPRESSED ───────────────────────────────────
 * Email from the tenant's own domain. It looks like an obvious self-send to
 * ignore, but the real data shows `sales@anutech.in` and
 * `pardeep@example.test` arriving as senders and correctly producing
 * leads — staff forward customer enquiries in. Suppressing own-domain would have
 * broken a path that works today.
 */

export type FollowUpPriority = "high" | "medium" | "low";

export interface FollowUpInput {
  /** Sender address, e.g. "no-reply@accounts.google.com". */
  fromEmail: string | null | undefined;
  subject: string | null | undefined;
  /** Plain-text body. Only the first few KB matter for this decision. */
  bodyText?: string | null;
  /** Gemini's verdict. `null` = the model did not run or failed. */
  isEnquiry: boolean | null;
  /** Gemini's one-line summary, when available. */
  summary?: string | null;
  /**
   * Raw headers, when the ingest provides them. `list-unsubscribe` is the most
   * reliable bulk-mail marker there is — far better than guessing from wording.
   */
  headers?: Record<string, string | undefined> | null;
  /** True when this email attached to an EXISTING lead rather than creating one. */
  isReplyToExistingLead?: boolean;
}

export interface FollowUpDecision {
  create: boolean;
  /** Which hard rule vetoed it, or null. Set even when `create` is false for
   *  a soft reason, so a log line can tell the two apart. */
  suppressedBy: string | null;
  /** One sentence, for the activity log and for the operator. */
  reason: string;
  priority: FollowUpPriority;
  /** Hours from now until the task is due. */
  dueInHours: number;
  /** Task title, already trimmed to something readable in a list. */
  title: string;
  /** Signals that pushed the priority up — shown so the score is explainable. */
  signals: string[];
}

/** Local-parts that never belong to a person who wants a reply. */
const ROBOT_LOCALS = [
  "no-reply", "noreply", "no_reply", "donotreply", "do-not-reply",
  "mailer-daemon", "postmaster", "bounce", "bounces", "notifications",
  "notification", "alerts", "alert", "automated", "auto-confirm",
];

/** Subject prefixes that mark a machine reply. */
const AUTO_SUBJECTS = [
  "automatic reply", "auto reply", "autoreply", "out of office", "ooo:",
  "undeliverable", "delivery status notification", "mail delivery",
  "returned mail", "delivery has failed", "undelivered mail",
  "message blocked", "spam notification",
];

/** Words that mean money is being discussed — the strongest follow-up signal. */
const MONEY_WORDS = [
  "quote", "quotation", "quotes", "price", "pricing", "cost", "rate", "rates",
  "budget", "discount", "invoice", "proposal", "renew", "renewal",
];

/** Urgency, in English and the Hinglish this business actually receives. */
const URGENCY_WORDS = [
  "urgent", "urgently", "asap", "immediately", "today", "right away",
  "jaldi", "turant", "abhi",
];

/** An explicit request for something. */
const ASK_WORDS = [
  "send me", "share", "please send", "can you", "could you", "need",
  "require", "looking for", "interested in", "chahiye", "bhej",
];

function norm(v: string | null | undefined): string {
  return (v ?? "").toString().toLowerCase();
}

function hit(haystack: string, needles: string[]): string | null {
  for (const n of needles) if (haystack.includes(n)) return n;
  return null;
}

/**
 * Decide.
 *
 * Order matters: hard suppressions, then the AI verdict, then signal scoring.
 */
export function decideFollowUp(input: FollowUpInput): FollowUpDecision {
  const from = norm(input.fromEmail);
  const subject = (input.subject ?? "").toString().trim();
  const subjectL = norm(subject);
  // Only the head of the body is scanned. A signal buried 40KB down is not what
  // the sender was asking about, and scanning the whole thing lets a quoted
  // thread from months ago drive today's priority.
  const bodyL = norm(input.bodyText).slice(0, 4000);
  const haystack = `${subjectL} ${bodyL}`;

  const no = (suppressedBy: string, reason: string): FollowUpDecision => ({
    create: false, suppressedBy, reason,
    priority: "low", dueInHours: 0, title: "", signals: [],
  });

  // ── Hard suppressions. The model cannot override these. ─────────────────
  const local = from.split("@")[0] ?? "";
  const robot = ROBOT_LOCALS.find((r) => local.includes(r));
  if (robot) {
    return no("robot_sender", `Sender looks automated ("${robot}") — nobody is waiting for a reply.`);
  }

  const auto = hit(subjectL, AUTO_SUBJECTS);
  if (auto) {
    return no("auto_reply", `Subject marks a machine reply or bounce ("${auto}").`);
  }

  // List-Unsubscribe is the definitive bulk marker. Header keys are
  // case-insensitive per RFC, so the lookup is normalised.
  if (input.headers) {
    const keys = Object.keys(input.headers).map((k) => k.toLowerCase());
    if (keys.includes("list-unsubscribe") || keys.includes("list-id")) {
      return no("bulk_mail", "Carries List-Unsubscribe — this is bulk mail, not a conversation.");
    }
    const precedence = norm(
      input.headers["Precedence"] ?? input.headers["precedence"]
    );
    if (precedence === "bulk" || precedence === "auto_reply" || precedence === "junk") {
      return no("bulk_mail", `Precedence: ${precedence} — machine-generated.`);
    }
    const autoSubmitted = norm(
      input.headers["Auto-Submitted"] ?? input.headers["auto-submitted"]
    );
    if (autoSubmitted && autoSubmitted !== "no") {
      return no("auto_reply", `Auto-Submitted: ${autoSubmitted} — machine-generated (RFC 3834).`);
    }
  }

  if (!from.includes("@")) {
    return no("no_sender", "No usable sender address, so a follow-up has nowhere to go.");
  }

  // ── The model's verdict ─────────────────────────────────────────────────
  // An explicit `false` is respected. `null` means Gemini did not run: the
  // webhook still creates the lead (right — never drop a real enquiry) but a
  // task is NOT created off an unverified guess. The lead sits in the queue for
  // a human, which is the honest outcome.
  if (input.isEnquiry === false) {
    return no("not_an_enquiry", "Classified as a non-sales email.");
  }
  if (input.isEnquiry === null || input.isEnquiry === undefined) {
    return no(
      "unclassified",
      "Email triage did not run, so this is left for manual review rather than "
      + "creating a task on an unchecked guess. The lead is still captured.",
    );
  }

  // ── Signal scoring ──────────────────────────────────────────────────────
  const signals: string[] = [];
  let score = 0;

  const money = hit(haystack, MONEY_WORDS);
  if (money) { score += 2; signals.push(`mentions ${money}`); }

  const urgency = hit(haystack, URGENCY_WORDS);
  if (urgency) { score += 2; signals.push(`urgency ("${urgency}")`); }

  const ask = hit(haystack, ASK_WORDS);
  if (ask) { score += 1; signals.push("explicit request"); }

  if (subject.includes("?") || bodyL.includes("?")) { score += 1; signals.push("asks a question"); }

  // "20 users", "25 seats", "100 email id" — a quantity means they have sized it.
  if (/\b\d{1,4}\s*(user|users|seat|seats|licen[cs]e|licen[cs]es|account|accounts|email|mailbox|id)\b/.test(haystack)) {
    score += 2; signals.push("names a quantity");
  }

  // A reply on a live deal is worth more than a cold first email: someone is
  // already mid-conversation and waiting.
  if (input.isReplyToExistingLead) { score += 1; signals.push("reply on an open lead"); }

  const priority: FollowUpPriority = score >= 4 ? "high" : score >= 2 ? "medium" : "low";
  const dueInHours = priority === "high" ? 4 : priority === "medium" ? 24 : 72;

  const subjectForTitle = subject || input.summary || "email enquiry";
  const who = from.split("@")[0] || from;
  const title = `Follow up: ${subjectForTitle}`.slice(0, 120);

  return {
    create: true,
    suppressedBy: null,
    reason: signals.length > 0
      ? `Follow-up warranted — ${signals.join(", ")}.`
      : `Follow-up warranted — inbound enquiry from ${who}.`,
    priority,
    dueInHours,
    title,
    signals,
  };
}
