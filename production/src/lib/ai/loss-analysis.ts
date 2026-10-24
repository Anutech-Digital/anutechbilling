// Not wired yet — R-1608 (built, kept for later)
/**
 * Why a deal was lost — and routing that answer to the right KIND of fix.
 *
 * ─── THIS IS THE SAFEST OF THE FOUR LEARNING LOOPS, FOR TWO REASONS ─────────
 * playbook.ts, reflection.ts and gold-standard.ts all had to refuse something. This one mostly
 * does not, and it is worth saying why rather than reaching for the same objection a fourth time.
 *
 * 1. LOST DEALS INVERT THE DANGEROUS SELECTION. A won-deal filter selects for what CLOSES deals,
 *    and the most persuasive thing to say is often the thing we cannot say — which is how a
 *    learning loop rediscovers "official Google Partner" and "2-hour migration". A lost-deal
 *    filter selects for what did NOT work, and there is no temptation to overclaim in "we were
 *    slow" or "they said the price was high".
 *
 * 2. RESPONSE DELAY IS A FACT ABOUT US. It comes off two timestamps. No customer text, no claim,
 *    no figure, nothing to redact — the cleanest signal in any of these four features.
 *
 * ─── BUT THE BRIEF'S OWN CONCLUSION DOES NOT FOLLOW ─────────────────────────
 * It asks two questions — "kya price zyada laga? kya response delay hua?" — and then prescribes
 * ONE answer to both: "GST Input Tax Credit Savings ko aur zyada emphasize karna shuru kar deta
 * hai."
 *
 * THOSE TWO DIAGNOSES HAVE OPPOSITE FIXES.
 *
 * Lost on PRICE, and leading with the tax credit is a reasonable response: the money genuinely
 * comes back, it is on our own invoice, and a buyer who has not counted it is comparing the wrong
 * number.
 *
 * Lost on DELAY, and emphasising the tax credit does nothing whatsoever. Nobody declined because
 * the pitch was under-argued; they declined because nothing arrived. The fix is operational —
 * open the dial, verify the sending domain — and changing the pitch instead does something worse
 * than nothing: it makes the numbers look like the pitch was the problem, so the next person to
 * read them goes and rewrites a prompt rather than turning on a setting.
 *
 * ─── AND TODAY EVERY LOSS ATTRIBUTABLE TO US IS A SILENCE LOSS ──────────────
 * Measured on the live tables:
 *
 *   quotes ............................ 31   (27 accepted, 3 draft, 1 sent)
 *   quotes LOST ....................... 0
 *   leads with lost_at set ............ 0
 *   lost_reason values ever recorded .. none
 *   agent turns ever written .......... 0
 *   held drafts on lead timelines ..... 12
 *
 * There are no lost deals to analyse — not few, zero. And response latency cannot be computed at
 * all, because the agent has never replied: twelve drafts were written and held. So if anything
 * is costing deals right now it is silence, and a loop that responded by emphasising the tax
 * credit harder would be treating a delivery failure with rhetoric.
 *
 * `diagnoseLoss` therefore returns a FIX KIND alongside the cause, and refuses a pitch change on
 * any cause that is not about the pitch. That routing is the feature.
 *
 * ─── ON AUTOMATING THE ADJUSTMENT: NOT NEVER, JUST NOT YET ──────────────────
 * The other three loops were refused automation on principle. This one should not be, and the
 * distinction is worth being precise about: adjusting which AUTHORISED claim we lead with cannot
 * introduce a claim, so its worst case is leading with the wrong TRUE thing, which costs a
 * suboptimal email. That is the safe axis lib/ai/tone.ts, trade-in.ts and ab-test.ts all use.
 *
 * What stops it today is the sample, not the principle — and `suggestEmphasis` says so in words
 * rather than refusing on grounds that would still hold at scale.
 */
import { AUTHORISED_CLAIMS, type AuthorisedClaim } from "./tone";
import { detectObjections } from "./battlecards";

/* ── Diagnosis ────────────────────────────────────────────────────────────── */

export type LossCause =
  /** They said the price was too high, in their own words. */
  | "price"
  /** We never replied at all. The draft was held, or nothing was drafted. */
  | "silence"
  /** We replied, but slowly enough that the deal had moved on. */
  | "delay"
  /** They stopped answering and said nothing about why. */
  | "went_quiet"
  /** They told us a reason that is neither price nor timing. */
  | "other_stated"
  /** Nothing on record says anything. */
  | "unknown";

/**
 * What KIND of change this diagnosis calls for. The routing that the brief collapsed.
 *
 * `pitch` — reorder which authorised claim leads. The only kind this module will ever suggest.
 * `operational` — a dial, a domain, a rota. Nothing about wording will help.
 * `none` — nothing on record supports a change, and inventing one is how a habit forms.
 */
export type FixKind = "pitch" | "operational" | "none";

export interface LossDiagnosis {
  cause: LossCause;
  fix: FixKind;
  /** One paragraph for a person: what happened, and what kind of thing would change it. */
  reason: string;
}

/**
 * How long a reply may take before the delay is the story.
 *
 * Twenty-four hours. Not a service standard — a diagnostic line: below it, a lost deal is
 * unlikely to have been lost on speed, and above it speed is a candidate. Deliberately generous,
 * because calling a two-hour reply "slow" would attribute losses to timing that were about
 * something else, and a diagnosis that over-reports one cause is worse than one that says
 * "unknown".
 */
export const SLOW_REPLY_HOURS = 24;

export interface LossInput {
  /** The customer's own messages on this deal. Read for a stated reason, then discarded. */
  customerMessages: readonly string[];
  /** Hours between their last message and our reply. Null when we never replied. */
  hoursToOurReply: number | null;
  /** True when a draft was written and held rather than sent. */
  draftWasHeld: boolean;
  /** A reason a colleague typed into `leads.lost_reason`, if any. */
  statedReason: string | null;
}

/**
 * Work out why, and what kind of fix follows.
 *
 * ─── SILENCE IS CHECKED BEFORE PRICE, AND THE ORDER IS THE POINT ────────────
 * A customer who said "too expensive" AND never got an answer did not decline the argument —
 * they declined the silence. Diagnosing that as a price objection would send somebody to rewrite
 * a pitch that was never delivered, and the price complaint would look like the cause because it
 * is the only thing in the transcript.
 */
export function diagnoseLoss(input: LossInput): LossDiagnosis {
  if (input.hoursToOurReply === null) {
    return {
      cause: "silence",
      fix: "operational",
      reason: input.draftWasHeld
        ? "A reply was drafted and never sent, so this deal was not lost on the pitch — it was " +
          "lost on silence. Nothing about the wording will change this outcome: open the dial " +
          "that held it, or verify the sending domain. Changing the pitch here would make the " +
          "numbers look like the argument was the problem."
        : "Nobody replied to this customer at all. The fix is a rota or a dial, not a rewrite.",
    };
  }

  if (input.hoursToOurReply > SLOW_REPLY_HOURS) {
    return {
      cause: "delay",
      fix: "operational",
      reason:
        `The reply took ${Math.round(input.hoursToOurReply)} hours, past the ${SLOW_REPLY_HOURS}-hour ` +
        "line where speed becomes a candidate cause. A better-argued pitch does not arrive any " +
        "sooner, so this is a dial or a rota rather than a wording change.",
    };
  }

  /* A colleague's typed reason outranks anything inferred from a transcript: they spoke to the
     customer and we are reading text. */
  const stated = input.statedReason?.trim().toLowerCase();
  if (stated) {
    const looksLikePrice = /price|cost|expensive|budget|mehng|mehen|sasta|rate/i.test(stated);
    return looksLikePrice
      ? {
          cause: "price",
          fix: "pitch",
          reason:
            "A colleague recorded this as a price loss. That is the one diagnosis a pitch change " +
            "answers: the input tax credit is real money coming back on our own invoice, and a " +
            "buyer who has not counted it is comparing the wrong number.",
        }
      : {
          cause: "other_stated",
          fix: "none",
          reason:
            "A colleague recorded a reason that is neither price nor timing. Nothing here " +
            "suggests a pitch change, and inventing one from a single loss is how a habit forms.",
        };
  }

  const objections = input.customerMessages.flatMap((m) => detectObjections(m));
  const raisedPrice = objections.some(
    (o) => o.id === "too_expensive" || o.id === "cheaper_elsewhere",
  );

  if (raisedPrice) {
    return {
      cause: "price",
      fix: "pitch",
      reason:
        "They raised the price themselves and we replied in time, so the argument was heard and " +
        "did not land. Leading with the input tax credit is a fair response — it is money that " +
        "genuinely comes back, on our own invoice.",
    };
  }

  return {
    cause: input.customerMessages.length > 0 ? "went_quiet" : "unknown",
    fix: "none",
    reason:
      input.customerMessages.length > 0
        ? "They stopped answering and said nothing about why. A guess here would become a habit, " +
          "so nothing is concluded — ask the next one why, and record it."
        : "Nothing on record says anything about this deal. No conclusion is available.",
  };
}

/* ── Emphasis ─────────────────────────────────────────────────────────────── */

/**
 * Below this many PRICE losses, no emphasis change is suggested.
 *
 * Fifteen, lower than the twenty-five used elsewhere in this codebase — deliberately, because
 * this decision is genuinely cheaper to get wrong. Reordering authorised claims cannot introduce
 * a claim, so a wrong answer costs a suboptimal email rather than a false statement, and the bar
 * should sit where the consequence does.
 */
export const MIN_PRICE_LOSSES_FOR_EMPHASIS = 15;

export interface EmphasisSuggestion {
  /** Which authorised claim to lead with. Null when there is not enough to say. */
  leadWith: AuthorisedClaim | null;
  /** How many price losses were counted. Always shown next to the suggestion. */
  priceLosses: number;
  /** Losses whose fix is operational rather than rhetorical. Reported so they are not ignored. */
  operationalLosses: number;
  /** Why nothing is suggested, in words. Empty when something is. */
  unavailable: string;
  /**
   * Whether applying this automatically would be safe.
   *
   * True only once the sample is there. Unlike the other loops in this family the answer is not
   * a flat no — see the module header on why reordering authorised claims is a different kind of
   * decision from rewriting a prompt.
   */
  safeToApplyAutomatically: boolean;
}

/**
 * What the losses suggest leading with, if anything.
 *
 * Returns a claim IDENTIFIER, never wording, and counts the operational losses separately so a
 * silence problem cannot hide inside a pitch recommendation.
 */
export function suggestEmphasis(diagnoses: readonly LossDiagnosis[]): EmphasisSuggestion {
  const priceLosses = diagnoses.filter((d) => d.cause === "price").length;
  const operationalLosses = diagnoses.filter((d) => d.fix === "operational").length;

  if (operationalLosses > priceLosses) {
    return {
      leadWith: null,
      priceLosses,
      operationalLosses,
      safeToApplyAutomatically: false,
      unavailable:
        `More deals were lost to silence or delay (${operationalLosses}) than to price ` +
        `(${priceLosses}). No pitch change is suggested, because a better argument does not ` +
        "arrive any sooner — and suggesting one would make the numbers look like the argument " +
        "was the problem.",
    };
  }

  if (priceLosses < MIN_PRICE_LOSSES_FOR_EMPHASIS) {
    return {
      leadWith: null,
      priceLosses,
      operationalLosses,
      safeToApplyAutomatically: false,
      unavailable:
        `Only ${priceLosses} ${priceLosses === 1 ? "deal" : "deals"} were lost on price. ` +
        `Changing what every pitch leads with needs at least ${MIN_PRICE_LOSSES_FOR_EMPHASIS} — ` +
        "below that it is a handful of customers deciding what everybody hears first.",
    };
  }

  /* The GST invoice, which is where the input tax credit lives. Named by identifier from the
     authorised list rather than as a phrase — the same currency every ordering module here uses,
     so no claim can enter through this door. */
  const leadWith: AuthorisedClaim = "gst_invoice";
  if (!(AUTHORISED_CLAIMS as readonly string[]).includes(leadWith)) {
    /* Unreachable while the list contains it. Present because this is the one line in the file
       that names a claim, and a claim that fell off the list must not be suggested. */
    return {
      leadWith: null,
      priceLosses,
      operationalLosses,
      safeToApplyAutomatically: false,
      unavailable: "The claim this would lead with is no longer on the authorised list.",
    };
  }

  return {
    leadWith,
    priceLosses,
    operationalLosses,
    safeToApplyAutomatically: true,
    unavailable: "",
  };
}

/**
 * What has to be recorded before any of this can answer anything.
 *
 * Not a prohibition list like the other loops carry — a list of what is MISSING, because this
 * feature is blocked by absent data rather than by anything unsafe. Kept as data so the UI can
 * show it where somebody can act on it.
 */
export const LOSS_ANALYSIS_NEEDS: readonly string[] = [
  "`leads.lost_reason` has never been written — not once, across every lead. A colleague's typed " +
    "reason outranks anything inferred from a transcript, because they spoke to the customer and " +
    "the app is reading text. Until that field is filled in, most losses diagnose as 'went " +
    "quiet'.",
  "A deal has to be MARKED lost. `leads.lost_at` is null on every row, so there is nothing for " +
    "this to read: 31 quotes exist, 27 accepted and none lost.",
  "Response latency needs a reply to measure. The agent has written zero turns and twelve drafts " +
    "were held, so the only latency currently measurable is infinite — which is the finding, not " +
    "a gap in the data.",
];
