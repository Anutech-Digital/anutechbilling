/**
 * May the app answer this customer by itself?
 *
 * Step 2 of the agent plan. The DECISION only — the drafting and the sending live elsewhere,
 * so this can be argued about against a table instead of against a mail server.
 *
 * ─── SEVEN THINGS HAVE TO BE TRUE, AND SIX OF THEM FAIL QUIETLY ─────────────
 * The one that would be caught in testing is "the draft promises something". The other six
 * are the ones that produce a bad outcome while looking like success:
 *
 *   - replying to ourselves (a loop, and the worst failure here)
 *   - replying when THEY are not waiting — answering our own last message
 *   - replying twice to the same message
 *   - replying to a thread a human is already handling
 *   - sending an empty or truncated draft
 *   - sending when the drafter fell back to a template it did not write for this lead
 *
 * Each returns a sentence, because every refusal lands on the lead's timeline and on
 * /automation, where somebody has to decide what to do about it.
 *
 * ─── WHY "NOT ALREADY REPLIED" IS ITS OWN INPUT ─────────────────────────────
 * The inbound webhook is idempotent on `messageId`, so the same mail cannot be processed
 * twice — but that is the WEBHOOK's guarantee, not this decision's. A retry from a different
 * angle, a manual replay, or a second automated path added later would each reach here with
 * a message already answered. Two replies to one email is not a small error: the customer
 * gets two different sentences from the same company and has to ask which one counts.
 */
import { findPromises, type PromiseFinding } from "./promise-check";

export interface AutoReplyInput {
  /** From the disposition guard — never reply to our own address. */
  senderIsOurs: boolean;
  /**
   * A marked self-test from our own address — see lib/inbound/self-test.ts.
   *
   * Buys passage through the own-address rule and NOTHING else: a self-test with a promise
   * in it is still held, one where they did not write last is still held, and the workspace
   * dial still applies. Otherwise the test would prove a behaviour the real path does not
   * have, which is worse than not testing it.
   */
  isSelfTest?: boolean;
  /**
   * True when the newest message in the thread came FROM the customer. If our own message is
   * newest, nobody is waiting and a reply is us talking to ourselves in public.
   */
  theyWroteLast: boolean;
  /** Has an outbound message already been recorded against this inbound message? */
  alreadyReplied: boolean;
  /**
   * True when a person has touched this thread since the customer wrote — a draft opened, a
   * note added, a call logged. Somebody is on it, and a machine chiming in over them is
   * worse than silence.
   */
  humanIsHandlingIt: boolean;
  /** The drafted subject and body, exactly as they would be sent. */
  draft: { subject: string; message: string } | null;
  /**
   * The caller has ALREADY adjudicated promises with a stricter, better-informed check, so this
   * gate must not judge them a second time. Default false — every existing caller is unchanged.
   *
   * ─── WHY THIS EXISTS, MEASURED ON A LIVE MESSAGE (24 Aug 2026) ──────────────
   * `findPromises` runs its money check with an EMPTY allow-list, because on the path it was
   * written for — an acknowledgement — no figure is authorised at all. That is right there and
   * wrong for a SALES reply, whose entire job is to name a price.
   *
   * Measured, not reasoned: the first real enquiry the AI sales agent ever answered was held
   * here with `the draft commits us to something — it says "Rs 864" (and 2 more)`. Rs 864 is
   * the tenant's own catalogue price, read from `items.msrp` at call time; the "2 more" were
   * the 3.5% card-loading figure and the round-the-clock support line. Every one of them is a
   * thing the agent's own prompt authorises.
   *
   * The consequence was worse than a held reply. This gate sits UPSTREAM of the dial: when it
   * refuses, `run-sales-agent.ts` files the draft and returns without ever reaching the
   * dispatcher. So moving `reply.send` to `auto` would have changed nothing — no priced reply
   * could ever be sent, at any setting, and the feature's main path was closed while looking
   * open.
   *
   * ─── WHY IT IS SAFE FOR THE SALES PATH AND NOWHERE ELSE ─────────────────────
   * `applyHandoverRules` (lib/ai/sales-agent.ts) has already, by the time this is reached:
   *   · run `verifyDraftMoney` against the CATALOGUE figures on BOTH customer-visible surfaces
   *     — a stricter check than this one, because it knows which figures are real
   *   · refused any date, discount or guarantee, minus the two phrases the prompt authorises
   *   · overruled the model to HANDOVER_TO_HUMAN on any failure, so a failing draft never
   *     arrives here at all
   * A caller that passes this flag WITHOUT such a check has switched the rule off. There is a
   * test (auto-reply.test.ts) asserting no source file other than run-sales-agent.ts passes it.
   */
  promisesAlreadyChecked?: boolean;
  /**
   * False when the drafter produced a generic template rather than writing for this lead —
   * e.g. Gemini was unreachable. A template is fine for a person to adapt and wrong to send
   * unattended, because it is not an answer to what they actually asked.
   */
  draftIsForThisLead: boolean;
}

export type AutoReplyDecision =
  | { send: true; reason: string }
  | { send: false; reason: string; findings?: PromiseFinding[] };

/** Shorter than this is not a reply. Two lines of greeting and nothing else. */
const MIN_MESSAGE_CHARS = 40;

export function decideAutoReply(input: AutoReplyInput): AutoReplyDecision {
  if (input.senderIsOurs && !input.isSelfTest) {
    /* First, and the worst one to get wrong: a reply to ourselves that lands back in the
       inbox is a loop with a customer-facing mailbox in the middle of it.

       The self-test escape sits INSIDE this branch, exactly as it does in
       lib/inbound/disposition.ts and lib/quotes/auto-send-quote.ts. It was MISSING here and
       that was an oversight, not a decision: I added it to the quote sender in the same
       sitting and not to this one, so a marked self-test could exercise the whole chain
       except the one step it was written to prove. Found on 24 Aug 2026 when the first
       successful AI draft came back `held` for the wrong reason — "the sender is one of our
       own addresses" rather than "replies are set to hold for this workspace".

       The loop this could open is closed by the marker rule, not by this check: `isSelfTest`
       requires the subject to BEGIN with the marker, and a reply we send is subjected either
       from the model or as "Re: your enquiry" — neither can start with it. There is a test
       for that exact subject in lib/inbound/self-test.test.ts. */
    return { send: false, reason: "the sender is one of our own addresses — nothing is answered automatically" };
  }

  if (!input.theyWroteLast) {
    return {
      send: false,
      reason: "our own message is the newest one in this thread, so nobody is waiting on a reply",
    };
  }

  if (input.alreadyReplied) {
    /* Two replies to one email is not a small error — the customer gets two sentences from
       the same company and has to ask which one counts. */
    return { send: false, reason: "this message has already been answered — not answering it twice" };
  }

  if (input.humanIsHandlingIt) {
    return {
      send: false,
      reason: "somebody on the team has already picked this thread up, so it is theirs to answer",
    };
  }

  const subject = (input.draft?.subject ?? "").trim();
  const message = (input.draft?.message ?? "").trim();

  if (!input.draft || !message) {
    return { send: false, reason: "no draft was produced, so there is nothing to send" };
  }

  if (message.length < MIN_MESSAGE_CHARS) {
    /* A truncated generation reads as a snub. Better to hold a stub than to send one. */
    return {
      send: false,
      reason: `the draft is only ${message.length} characters, which is too short to be a real reply`,
    };
  }

  if (!input.draftIsForThisLead) {
    return {
      send: false,
      reason:
        "the draft is a generic template, not written for this enquiry — fine for you to adapt, " +
        "wrong to send unattended",
    };
  }

  /* THE RULE. Subject AND body: a promise in a subject line is the part they read before
     opening anything.

     SKIPPED only when the caller has already run a STRICTER, allow-list-aware version of the
     same check — see `promisesAlreadyChecked`. The other six conditions above always run. */
  if (!input.promisesAlreadyChecked) {
    const promises = findPromises(`${subject}\n${message}`);
    if (!promises.safe) {
      return { send: false, reason: promises.reason, findings: promises.findings };
    }
  }

  return {
    send: true,
    reason: input.promisesAlreadyChecked
      ? "they wrote last, nobody has picked it up, and the caller's own money and promise guards cleared the draft"
      : "they wrote last, nobody has picked it up, and the reply promises nothing",
  };
}
