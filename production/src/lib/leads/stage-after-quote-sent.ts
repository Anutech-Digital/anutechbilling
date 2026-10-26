/**
 * A quote just went to the customer. Should the lead move to "Quote Sent"?
 *
 * ─── THE BUG, REPORTED BY THE PERSON IT COST ────────────────────────────────
 * Darshan, 24 Aug 2026: "Customer ko quotation sent kar di lekin Quote sent mein show nahi
 * kar raha."
 *
 * He was right, and the cause is one line in lib/leads/folders.ts:
 *
 *     case "quoted": return l.is_junk !== true && l.stage === "quote";
 *
 * "Quote Sent" is a lead STAGE, not a fact about quotes. And grepping the whole codebase,
 * the ONLY place that ever set `stage: "quote"` was the public buy-page checkout. Sending a
 * quote from inside the app — the operator's Send button, the auto-quote from an inbound
 * email, a renewal — never touched it. So the quote really went, and the column named after
 * that act stayed empty.
 *
 * ─── WHY THIS IS ALLOWED TO WRITE, WHEN THE MORNING'S ANSWER WAS "DO NOT" ───
 * Earlier the same day Pardeep chose, from four options with the costs stated, that the app
 * should NOT advance a stage by itself — it should nudge. That decision stands, and this is
 * not an exception to it. It is the same rule.
 *
 * The rule is: automation opens on a FACT, never on a guess. "An activity was logged" is a
 * guess about what it meant — a call might have been a wrong number. "A quote was emailed to
 * this customer" is not a guess at all; it is precisely, exactly, the thing the words "Quote
 * Sent" describe. Refusing to write there would not be caution, it would be a column that
 * lies about its own name.
 *
 * ─── FORWARD ONLY, AND THAT IS THE WHOLE RISK ───────────────────────────────
 * The funnel is new → contact → demo → trial → quote → won. An upsell quote to a WON
 * customer, or a fresh quote on a lead someone marked LOST, must not drag it backwards into
 * the pipeline — that would corrupt the board, the stage-age badge and the forecast, all of
 * which read the stage. Every refusal below is a backwards move.
 */

/** Funnel order. `won` and `lost` are terminal and deliberately absent. */
const FORWARD_OF_QUOTE = ["new", "contact", "demo", "trial"] as const;

export interface StageAfterQuoteSent {
  /** The stage to write, or null to leave it alone. */
  nextStage: "quote" | null;
  /** Always present — the caller logs it either way, so a no-op is explicable too. */
  reason: string;
}

export function stageAfterQuoteSent(currentStage: string | null | undefined): StageAfterQuoteSent {
  const stage = (currentStage ?? "").trim().toLowerCase();

  if (!stage) {
    /* No stage at all is not a lead we understand, and guessing one from a quote send would
       be inventing pipeline position out of a single event. */
    return { nextStage: null, reason: "the lead has no stage recorded, so nothing was moved" };
  }

  if (stage === "quote") {
    return { nextStage: null, reason: "the lead is already in Quote Sent" };
  }

  if (stage === "won") {
    /* An upsell quote to a won customer. Pulling them back into the pipeline would double-
       count them in the forecast and restart their stage age. */
    return {
      nextStage: null,
      reason: "the deal is already Won — a further quote does not move it back into the pipeline",
    };
  }

  if (stage === "lost") {
    /* A re-engagement quote. Somebody decided this was lost, and a quote going out is not
       the same as that decision being reversed — the person who reopens it should be the
       person who closed it. */
    return {
      nextStage: null,
      reason: "the lead is marked Lost — reopening it is a person's decision, not a side effect of a quote",
    };
  }

  if ((FORWARD_OF_QUOTE as readonly string[]).includes(stage)) {
    return { nextStage: "quote", reason: `quote sent, so the lead moved from ${stage} to Quote Sent` };
  }

  /* An unknown stage — a value added to the DB but not to this list. Left alone and SAID,
     rather than assumed to be early in the funnel: a wrong forward move is as damaging as a
     wrong backward one, and this is the branch a future stage would land in. */
  return {
    nextStage: null,
    reason: `stage "${stage}" is not one this rule knows, so it was left alone`,
  };
}

export interface StageAfterQuoteSaved {
  /** The stage to write, or null to leave it alone. */
  nextStage: "quote" | "contact" | null;
  reason: string;
}

/**
 * R-1959 — a quote was SAVED for this lead (draft or sent). The one rule both builder paths
 * use: the new prospect lead (prospectLeadRow) and the existing lead.
 *
 * Pardeep, localhost: a draft quote was made for a New lead and the lead stayed at New. Making
 * a quote for someone is contact, so a draft moves New → Contacted. A sent quote is exactly
 * stageAfterQuoteSent. Forward only: a draft never touches contact / demo / trial / quote /
 * won / lost, a missing stage or one this rule does not know.
 */
export function stageAfterQuoteSaved(currentStage: string | null | undefined, sent: boolean): StageAfterQuoteSaved {
  if (sent) return stageAfterQuoteSent(currentStage);
  const stage = (currentStage ?? "").trim().toLowerCase();
  if (stage === "new") {
    return { nextStage: "contact", reason: "a quote was drafted, so the lead moved from New to Contacted" };
  }
  if (!stage) return { nextStage: null, reason: "the lead has no stage recorded, so nothing was moved" };
  return { nextStage: null, reason: `a draft quote does not move a lead that is already at ${stage}` };
}
