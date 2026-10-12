import { describe, it, expect } from "vitest";
import { pillsFor, pillDraft, replySubject, type PillContext } from "./reply-pills";
import { denyTermsRe } from "@/test/deny-terms";

/** The live enquiry: Pardeep, 20 seats, Google Workspace Standard, no phone number. */
const LIVE: PillContext = {
  contactName: "Pardeep Sharma",
  product: "Google Workspace Standard",
  seats: 20,
  hasPhone: false,
  sellerName: "ANUTECH DIGITAL PVT LTD",
};

describe("a pill is only worth a tap if it knows the enquiry", () => {
  it("repeats back what they actually asked for", () => {
    const d = pillDraft("quote", LIVE);
    expect(d).toContain("20 users");
    expect(d).toContain("Google Workspace Standard");
  });

  it("greets by FIRST name — a full name reads like a form letter", () => {
    expect(pillDraft("quote", LIVE)).toContain("Hi Pardeep,");
    expect(pillDraft("quote", LIVE)).not.toContain("Hi Pardeep Sharma");
  });

  it("says plain 'Hello' rather than 'Hi there' when the name is unknown", () => {
    /* A greeting that admits it does not know you is worse than none. */
    const d = pillDraft("quote", { ...LIVE, contactName: null });
    expect(d).toContain("Hello,");
    expect(d).not.toMatch(/hi there/i);
  });

  it("does not invent a name out of an email handle or junk", () => {
    for (const junk of ["", "   ", "1234", "-", "a"]) {
      expect(pillDraft("quote", { ...LIVE, contactName: junk })).toContain("Hello,");
    }
  });

  it("simply omits what it does not know, rather than leaving a gap", () => {
    const d = pillDraft("quote", { contactName: null, product: null, seats: null });
    expect(d).not.toMatch(/for\s*\./);
    expect(d).not.toMatch(/undefined|null|NaN/);
  });

  it("uses the singular for one seat", () => {
    expect(pillDraft("quote", { ...LIVE, seats: 1 })).toContain("1 user");
    expect(pillDraft("quote", { ...LIVE, seats: 1 })).not.toContain("1 users");
  });
});

/**
 * ─── NO PRICES, EVER ────────────────────────────────────────────────────────
 * Pricing has one home: the quote builder, where the catalogue rate, the discount and the
 * GST split are computed together. A number typed into an email is one nobody can
 * reconcile against the invoice that follows — and the customer will hold us to it.
 */
describe("no pill quotes a price", () => {
  it.each(["quote", "phone", "call"] as const)("%s carries no rupee figure", (id) => {
    const d = pillDraft(id, LIVE);
    expect(d).not.toMatch(/₹|rs\.?\s*\d|\d{3,}\s*(?:per|\/)/i);
  });

  it("promises the quote instead of pricing it", () => {
    expect(pillDraft("quote", LIVE)).toMatch(/preparing the quotation/i);
  });
});

/**
 * ─── NO PLACEHOLDERS ────────────────────────────────────────────────────────
 * A draft containing "[insert date]" is a draft that gets sent containing "[insert date]".
 */
describe("nothing needs filling in by hand", () => {
  it.each(["quote", "phone", "call"] as const)("%s has no bracketed blanks", (id) => {
    const d = pillDraft(id, LIVE);
    expect(d).not.toMatch(/\[[^\]]*\]|<[^>]*>|XXX|TBD/i);
  });

  it("offers relative times, not invented calendar dates", () => {
    /* This module cannot know the reseller's calendar. "Tuesday 3pm" would put a
       commitment in their mouth. */
    const d = pillDraft("call", LIVE);
    expect(d).toMatch(/tomorrow morning|late afternoon/i);
    expect(d).not.toMatch(/\b(?:mon|tue|wed|thu|fri)day\b/i);
  });

  it("gives two concrete windows rather than 'let me know when suits'", () => {
    /* An open question is the most common way a warm enquiry goes quiet. */
    expect(pillDraft("call", LIVE)).toMatch(/whichever is easier/i);
  });
});

describe("which pills are offered", () => {
  it("offers the phone ask ONLY when there is no number", () => {
    /* Asking a customer for something already on file makes the reseller look like they
       did not read the email. */
    expect(pillsFor(LIVE).map((p) => p.id)).toContain("phone");
    expect(pillsFor({ ...LIVE, hasPhone: true }).map((p) => p.id)).not.toContain("phone");
  });

  it("always offers the quote and the call", () => {
    for (const ctx of [LIVE, { ...LIVE, hasPhone: true }, {}]) {
      const ids = pillsFor(ctx).map((p) => p.id);
      expect(ids).toContain("quote");
      expect(ids).toContain("call");
    }
  });

  it("gives every pill a reason, shown on hover", () => {
    for (const p of pillsFor(LIVE)) expect(p.hint.length).toBeGreaterThan(25);
  });
});

describe("the sign-off", () => {
  it("signs with the tenant", () => {
    expect(pillDraft("quote", LIVE)).toContain("ANUTECH DIGITAL PVT LTD");
  });

  it("goes UNSIGNED when the seller is unknown, never with a placeholder", () => {
    /* Same rule as lib/whatsapp.ts: no name beats the wrong name. */
    const d = pillDraft("quote", { ...LIVE, sellerName: null });
    expect(d).not.toMatch(/best regards/i);
    expect(d).not.toMatch(denyTermsRe());
  });
});

describe("the reply subject", () => {
  it("prefixes Re: so the customer's client threads it", () => {
    expect(replySubject("mujhe 20 email chahiye")).toBe("Re: mujhe 20 email chahiye");
  });

  it("does NOT stack a second Re:", () => {
    /* "Re: Re: Re:" is the surest sign an inbox was built by somebody who never used one. */
    expect(replySubject("Re: pricing")).toBe("Re: pricing");
    expect(replySubject("RE: pricing")).toBe("RE: pricing");
  });

  it("falls back to something meaningful on a subject-less email", () => {
    expect(replySubject(null)).toBe("Re: your enquiry");
    expect(replySubject("   ")).toBe("Re: your enquiry");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Reported 22 Aug 2026 from the lead drawer, with a screenshot.

   The thread was:
     us       → "your enquiry for 50 users of Google Workspace Business Starter"
     customer → "Actually, I need the quotation for 20 users of Business
                 Standard, not 50 users of Starter. Please adjust that."

   And the "Quote is on the way" pill filled the composer with:

     "Thank you for your enquiry for 50 users of Google Workspace Business
      Starter. I am preparing the quotation now and will send it across shortly.
      If the number of users changes before then, just reply here and I will
      adjust it."

   It restated the exact figures the customer had just corrected, and then invited
   them to do the thing they had already done. Not a wrong template — a template
   fed a stale snapshot. `PillContext.seats`/`.product` come from the LEAD row,
   which records the FIRST enquiry; the newest inbound message is newer
   information and nothing told the pill it existed.

   This module already holds the principle it needed: the phone pill is hidden
   when a number is on file, because (its words) "a button that asks a customer
   for something already on file makes the reseller look like they did not read
   the email." Restating superseded seats is the same failure.

   The fix is NOT to guess the new numbers — this module never guesses (see
   `whatTheyAskedFor`, "or nothing, never a guess"). It is to stop asserting facts
   that may have been overtaken.
   ───────────────────────────────────────────────────────────────────────────── */
describe("a customer reply supersedes the lead's stored facts", () => {
  const stale = {
    contactName: "test",
    product: "Google Workspace Business Starter",
    seats: 50,
    sellerName: "ANUTECH DIGITAL PVT LTD",
    factsSuperseded: true,
  };

  it("does not restate seats or product the customer may have just corrected", () => {
    const d = pillDraft("quote", stale);
    expect(d).not.toContain("50");
    expect(d).not.toContain("Business Starter");
  });

  it("does not invent the corrected figures either", () => {
    /* The reply said 20 users of Standard. This module cannot parse that and must
       not pretend to — a guessed seat count in an email is worse than none. */
    const d = pillDraft("quote", stale);
    expect(d).not.toContain("20");
    expect(d).not.toContain("Business Standard");
  });

  it("stops inviting a correction the customer has already sent", () => {
    /* The line that made the draft read as unread mail. */
    expect(pillDraft("quote", stale)).not.toMatch(/if the number of users changes/i);
  });

  it("acknowledges that they have written, so the reply is not generic", () => {
    const d = pillDraft("quote", stale);
    expect(d).toMatch(/Hi test,/);
    expect(d).toMatch(/quotation/i);
    /* Still a real reply, not a stub. */
    expect(d.length).toBeGreaterThan(80);
  });

  it("still signs off with the reseller's own name", () => {
    expect(pillDraft("quote", stale)).toContain("ANUTECH DIGITAL PVT LTD");
  });

  it("leaves the other two pills' behaviour alone", () => {
    /* "Suggest a call" never restated the seat count as a commitment, and asking
       for a phone number is unaffected by a change of requirement. Narrow fix. */
    for (const id of ["phone", "call"] as const) {
      expect(pillDraft(id, stale).length).toBeGreaterThan(80);
    }
  });

  it("behaves exactly as before on a FIRST enquiry, where nothing is superseded", () => {
    /* The regression risk: a fresh enquiry must keep repeating the facts back,
       which is what makes the pill worth a tap in the first place. */
    const fresh = pillDraft("quote", { ...stale, factsSuperseded: false });
    expect(fresh).toContain("50 users");
    expect(fresh).toContain("Google Workspace Business Starter");
    expect(fresh).toMatch(/if the number of users changes/i);
  });

  it("treats an absent flag as a first enquiry", () => {
    const { factsSuperseded: _omit, ...noFlag } = stale;
    expect(pillDraft("quote", noFlag)).toContain("50 users");
  });
});
