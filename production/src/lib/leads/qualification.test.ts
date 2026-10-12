import { describe, it, expect } from "vitest";
import {
  JUNK_REASONS, junkReason, junkNoteRequired, validateJunk,
  qualificationChecks, qualification, type JunkReasonId, type QualifiableLead,
} from "./qualification";

const lead = (over: Partial<QualifiableLead> = {}): QualifiableLead => ({
  contact_phone: "+91 98765 43210",
  contact_email: "user1@betaco.test",
  plan: "Google Workspace Business Starter",
  seats: 14,
  expected_close_date: "2026-09-01",
  ...over,
} as QualifiableLead);

describe("junk reasons", () => {
  it("offers every reason the brief asked for", () => {
    const ids = JUNK_REASONS.map((r) => r.id);
    expect(ids).toContain("fake_phone");
    expect(ids).toContain("spam_email");
    expect(ids).toContain("not_commercial");
    expect(ids).toContain("unresponsive");
  });

  it("separates the recoverable ones from the permanent ones", () => {
    /* The field that earns its keep. A fake number today can be a real one tomorrow,
       so the lead stays findable. A student enquiry will not become a business one.
       Showing both as the same dead end is how a recoverable enquiry is lost. */
    expect(junkReason("fake_phone").recoverable).toBe(true);
    expect(junkReason("unresponsive").recoverable).toBe(true);
    expect(junkReason("not_commercial").recoverable).toBe(false);
  });

  it("counts only actual spam as spam", () => {
    /* A student asking a real question is a real human and a poor fit; a bounced
       submission is a bot. Both are junk and only one is spam — a channel decision
       made on a number that mixed them would cut a source that is working.

       Asserted on the FIELD, not the prose. The first version of this test grepped
       the description for /spam/i and failed on the copy "Not counted as spam",
       which says the right thing and contains the wrong word. Prose is for humans;
       a boolean is for the assertion. */
    expect(junkReason("spam_email").countsAsSpam).toBe(true);
    expect(junkReason("not_commercial").countsAsSpam).toBe(false);
    expect(junkReason("fake_phone").countsAsSpam).toBe(false);
    expect(junkReason("unresponsive").countsAsSpam).toBe(false);
  });

  it("tells the rep what each choice DOES, not just what it is called", () => {
    for (const r of JUNK_REASONS) expect(r.consequence.length).toBeGreaterThan(20);
  });

  it("throws on an unknown reason instead of quietly filing it as `other`", () => {
    /* A junk record whose reason silently became "other" is exactly the unexplained
       bin this module exists to prevent. */
    // @ts-expect-error deliberately invalid
    expect(() => junkReason("because")).toThrow(/Unknown junk reason/);
  });
});

describe("validateJunk", () => {
  it("accepts a listed reason", () => {
    expect(validateJunk({ reasonId: "fake_phone", note: "" })).toEqual({ ok: true });
  });

  it("refuses junk with no reason at all", () => {
    // @ts-expect-error the UI must not be able to submit this
    const v = validateJunk({ reasonId: "", note: "" });
    expect(v.ok).toBe(false);
  });

  it("makes `Something else` actually say something", () => {
    /* A free-text reason of "" explains nothing, which defeats the point. */
    expect(junkNoteRequired("other")).toBe(true);
    const empty = validateJunk({ reasonId: "other", note: "  " });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toMatch(/needs a note/);
    expect(validateJunk({ reasonId: "other", note: "duplicate of L-99" })).toEqual({ ok: true });
  });

  it("does not demand a note for the listed reasons", () => {
    for (const id of ["fake_phone", "spam_email", "not_commercial", "unresponsive"] as JunkReasonId[]) {
      expect(junkNoteRequired(id)).toBe(false);
      expect(validateJunk({ reasonId: id, note: "" }).ok).toBe(true);
    }
  });
});

describe("qualification — derived from the row, never ticked", () => {
  it("passes a lead that has everything", () => {
    const v = qualification(lead());
    expect(v.qualified).toBe(true);
    expect(v.passedCount).toBe(3);
    expect(v.blocker).toBeNull();
  });

  it("needs BOTH phone and email, not either", () => {
    /* A quote goes out by email and gets chased by phone. One without the other
       stalls the deal at exactly the wrong moment. */
    expect(qualification(lead({ contact_phone: null })).qualified).toBe(false);
    expect(qualification(lead({ contact_email: null })).qualified).toBe(false);
  });

  it("rejects a phone number that cannot actually be dialled", () => {
    /* Present is not the same as usable — this is the check a tickbox could not make. */
    expect(qualification(lead({ contact_phone: "12345" })).qualified).toBe(false);
    expect(qualification(lead({ contact_phone: "1234567890" })).qualified).toBe(false);
    expect(qualification(lead({ contact_phone: "09876543210" })).qualified).toBe(true);
  });

  it("rejects an email that is not an email", () => {
    expect(qualification(lead({ contact_email: "user1@" })).qualified).toBe(false);
    expect(qualification(lead({ contact_email: "not an email" })).qualified).toBe(false);
  });

  it("needs a plan chosen", () => {
    const v = qualification(lead({ plan: null }));
    expect(v.qualified).toBe(false);
    expect(v.blocker).toMatch(/which licence/);
  });

  it("treats a whitespace-only plan as no plan", () => {
    expect(qualification(lead({ plan: "   " })).qualified).toBe(false);
  });

  it("needs seats AND a date, and says which is missing", () => {
    expect(qualification(lead({ seats: 0 })).blocker).toMatch(/how many seats/);
    expect(qualification(lead({ expected_close_date: null })).blocker).toMatch(/no expected close date/);
    expect(qualification(lead({ seats: 0, expected_close_date: null })).blocker)
      .toMatch(/No seat count and no expected close date/);
  });

  it("reports the FIRST unmet gate, not all of them", () => {
    /* A rep chasing three things at once chases none. The next phone call has one
       purpose. */
    const v = qualification(lead({ contact_phone: null, plan: null, seats: 0 }));
    expect(v.blocker).toMatch(/phone/i);
    expect(v.passedCount).toBe(0);
  });

  it("every unmet check says what is missing; every met one says nothing", () => {
    for (const c of qualificationChecks(lead({ plan: null }))) {
      if (c.passed) expect(c.missing).toBeNull();
      else expect(c.missing!.length).toBeGreaterThan(10);
    }
  });

  it("survives a completely empty lead", () => {
    const v = qualification({
      contact_phone: null, contact_email: null, plan: null,
      seats: null, expected_close_date: null,
    } as QualifiableLead);
    expect(v.qualified).toBe(false);
    expect(v.passedCount).toBe(0);
    expect(v.blocker).not.toBeNull();
  });
});
