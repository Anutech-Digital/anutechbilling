import { describe, it, expect } from "vitest";
import { stubDraft, type StubDraftArgs } from "./stub-draft";
import { denyTermsRe } from "@/test/deny-terms";

const PURPOSES = ["followup", "reminder", "renewal"] as const;
const CHANNELS = ["whatsapp", "email"] as const;

const base: StubDraftArgs = {
  channel:     "email",
  firstName:   "Ravi",
  company:     "Kailash Corporation",
  planLabel:   "Google Workspace Business Standard",
  purpose:     "followup",
  outstanding: 21_240,
  renewalDate: "2026-11-01",
  signOff:     "ANUTECH DIGITAL PVT LTD",
};

/** Every draft this function can produce, for the sweeps below. */
function everyDraft(signOff = base.signOff) {
  return PURPOSES.flatMap((purpose) =>
    CHANNELS.map((channel) => ({
      purpose, channel,
      draft: stubDraft({ ...base, purpose, channel, signOff }),
    })),
  );
}

describe("stubDraft", () => {
  it("produces a draft for all six purpose × channel combinations", () => {
    /* Guards the sweeps below from passing vacuously if a branch stops returning. */
    const all = everyDraft();
    expect(all).toHaveLength(6);
    for (const { purpose, channel, draft } of all) {
      expect(draft.message.length, `${purpose}/${channel}`).toBeGreaterThan(40);
    }
  });

  it("NEVER names a company the caller did not supply", () => {
    /* The bug. Three email variants ended "Thanks,\nDemo Co" — a
       hardcoded company in text the operator sends to their own customer.
       lib/whatsapp.ts fixed exactly this and its test still guards it; the fix
       never reached this function. Brand-agnostic on purpose: a guard naming one
       retired brand passes the day somebody hardcodes the current one. */
    for (const { purpose, channel, draft } of everyDraft("Delfos Technologies")) {
      const text = `${draft.subject}\n${draft.message}`;
      expect(text, `${purpose}/${channel}`).not.toMatch(denyTermsRe());
      expect(text, `${purpose}/${channel}`).not.toMatch(/anutech/i);
      expect(text, `${purpose}/${channel}`).not.toMatch(/pardeep/i);
    }
  });

  it("signs every EMAIL draft with the sign-off it was given", () => {
    for (const purpose of PURPOSES) {
      const d = stubDraft({ ...base, purpose, channel: "email", signOff: "Delfos Technologies" });
      expect(d.message, purpose).toContain("Delfos Technologies");
    }
  });

  it("does not sign WhatsApp drafts at all", () => {
    /* A WhatsApp thread already shows who is writing, so a signature there is
       noise — and these three variants never had one, which is precisely why the
       email gap survived unnoticed. */
    for (const purpose of PURPOSES) {
      const d = stubDraft({ ...base, purpose, channel: "whatsapp", signOff: "Delfos Technologies" });
      expect(d.message, purpose).not.toContain("Delfos Technologies");
      expect(d.subject, purpose).toBe("");
    }
  });

  it("restates the outstanding amount in whole rupees, Indian grouping", () => {
    /* 21240 is ₹21,240 — not ₹2,12,40,000 (a paise misread) and not ₹212.40. */
    const d = stubDraft({ ...base, purpose: "reminder", channel: "email", outstanding: 21_240 });
    expect(d.message).toContain("₹21,240");
    expect(d.message).not.toMatch(/2,12,400|212\.40/);
  });

  it("never invents a figure the caller did not pass", () => {
    /* This function exists as the fallback for when the MODEL invented a number,
       so it must not do the same. The only rupee figure in a reminder is the one
       supplied. */
    const d = stubDraft({ ...base, purpose: "reminder", channel: "email", outstanding: 4_500 });
    const figures = d.message.match(/₹[\d,]+/g) ?? [];
    expect(figures).toEqual(["₹4,500"]);
  });

  it("says 'soon' rather than inventing a date when the renewal date is unknown", () => {
    const d = stubDraft({ ...base, purpose: "renewal", channel: "email", renewalDate: null });
    expect(d.message).toContain("soon");
    /* No fabricated date. Nothing that looks like one. */
    expect(d.message).not.toMatch(/\d{1,2}\s+\w{3}\s+\d{4}/);
  });

  it("carries the customer's own name and plan into the text", () => {
    const d = stubDraft({ ...base, purpose: "followup", channel: "email" });
    expect(d.message).toContain("Ravi");
    expect(d.message).toContain("Kailash Corporation");
    expect(d.message).toContain("Google Workspace Business Standard");
  });
});

describe("an absent sign-off", () => {
  it("omits the signature block rather than trailing 'Thanks,' into nothing", () => {
    /* lib/whatsapp.ts's rule: no name beats the wrong name — and beats a dangling
       salutation, which is what a naive `Thanks,\n${""}` produces. */
    for (const purpose of PURPOSES) {
      const d = stubDraft({ ...base, purpose, channel: "email", signOff: "" });
      expect(d.message, purpose).not.toMatch(/Thanks,\s*$/);
      expect(d.message, purpose).not.toContain("Thanks,\n\n");
    }
  });

  it("treats a whitespace-only name as absent", () => {
    const d = stubDraft({ ...base, purpose: "followup", channel: "email", signOff: "   " });
    expect(d.message).not.toMatch(/Thanks,/);
  });

  it("trims a padded name rather than signing with the padding", () => {
    const d = stubDraft({ ...base, purpose: "followup", channel: "email", signOff: "  Delfos  " });
    expect(d.message).toContain("Thanks,\nDelfos");
  });
});
