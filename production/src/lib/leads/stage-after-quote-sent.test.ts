import { describe, it, expect } from "vitest";
import { stageAfterQuoteSent, stageAfterQuoteSaved } from "./stage-after-quote-sent";

/* ─────────────────────────────────────────────────────────────────────────────
   Darshan's report, 24 Aug 2026: "Customer ko quotation sent kar di lekin Quote sent mein
   show nahi kar raha."

   He was right. "Quote Sent" is a lead STAGE (folders.ts: `l.stage === "quote"`), and the
   only place in the whole codebase that ever set it was the public buy-page checkout. The
   operator's Send button, the auto-quote from an inbound email and renewals never touched
   it — so the quote really went and the column named after that act stayed empty.
   ───────────────────────────────────────────────────────────────────────────── */

describe("a quote going out moves the lead forward", () => {
  it.each(["new", "contact", "demo", "trial"])("advances a %s lead to Quote Sent", (stage) => {
    const d = stageAfterQuoteSent(stage);
    expect(d.nextStage).toBe("quote");
    expect(d.reason).toContain(stage);
  });

  it("is case- and whitespace-tolerant, because stages arrive from a text column", () => {
    expect(stageAfterQuoteSent(" Contact ").nextStage).toBe("quote");
  });
});

describe("it never moves a lead BACKWARDS — the whole risk of this rule", () => {
  it("leaves a WON deal alone when an upsell quote goes out", () => {
    /* Pulling a won customer back into the pipeline would double-count them in the forecast
       and restart their stage age. The board, the stage-age badge and the forecast all read
       this field. */
    const d = stageAfterQuoteSent("won");
    expect(d.nextStage).toBeNull();
    expect(d.reason).toMatch(/already Won/);
  });

  it("leaves a LOST lead alone when a re-engagement quote goes out", () => {
    /* Somebody decided it was lost. A quote leaving is not that decision being reversed —
       the person who closed it should be the one who reopens it. */
    const d = stageAfterQuoteSent("lost");
    expect(d.nextStage).toBeNull();
    expect(d.reason).toMatch(/marked Lost/);
  });

  it("does not rewrite a lead already in Quote Sent", () => {
    /* A second quote on the same lead is common — revise and resend. Writing the same value
       again would bump updated_at and log a change that changed nothing. */
    const d = stageAfterQuoteSent("quote");
    expect(d.nextStage).toBeNull();
    expect(d.reason).toMatch(/already in Quote Sent/);
  });
});

describe("what it refuses to guess", () => {
  it.each([null, undefined, "", "   "])("leaves a lead with no stage (%j) alone", (stage) => {
    const d = stageAfterQuoteSent(stage);
    expect(d.nextStage).toBeNull();
    expect(d.reason).toMatch(/no stage recorded/);
  });

  it("leaves an UNKNOWN stage alone and names it", () => {
    /* The branch a future stage lands in. Treating an unrecognised value as "early in the
       funnel" would be a wrong forward move, which is exactly as damaging as a wrong
       backward one — and this is the failure that would ship silently when somebody adds a
       stage to the database and not to this file. */
    const d = stageAfterQuoteSent("negotiation");
    expect(d.nextStage).toBeNull();
    expect(d.reason).toContain("negotiation");
    expect(d.reason).toMatch(/not one this rule knows/);
  });
});

describe("it always says why, including when it does nothing", () => {
  it.each(["new", "won", "lost", "quote", "banana"])("gives a reason for %j", (stage) => {
    /* The caller logs this either way. A no-op with no explanation is what made the original
       bug invisible: the quote went, the column stayed empty, and nothing anywhere said the
       stage had been considered and left. */
    expect(stageAfterQuoteSent(stage).reason.length).toBeGreaterThan(20);
  });
});

/* R-1959: Pardeep, localhost — a draft quote was saved for a New lead and the lead stayed at
   New. Making a quote IS contact; a draft must still never move a lead backward. */
describe("R-1959: stageAfterQuoteSaved — one rule for draft and sent", () => {
  it("a draft moves a New lead to Contacted", () => {
    expect(stageAfterQuoteSaved("new", false).nextStage).toBe("contact");
    expect(stageAfterQuoteSaved(" New ", false).nextStage).toBe("contact");
  });
  it.each(["contact", "demo", "trial", "quote", "won", "lost"])("a draft leaves a %s lead where it is", (stage) => {
    expect(stageAfterQuoteSaved(stage, false).nextStage).toBeNull();
  });
  it("a draft on a lead with no stage, or an unknown one, moves nothing", () => {
    expect(stageAfterQuoteSaved(null, false).nextStage).toBeNull();
    expect(stageAfterQuoteSaved("nurture", false).nextStage).toBeNull();
  });
  it.each(["new", "contact", "demo", "trial", "quote", "won", "lost", null, "nurture"])(
    "sent behaves exactly like stageAfterQuoteSent for %s",
    (stage) => {
      expect(stageAfterQuoteSaved(stage, true)).toEqual(stageAfterQuoteSent(stage));
    },
  );
});
