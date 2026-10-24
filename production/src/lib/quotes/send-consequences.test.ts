import { describe, it, expect } from "vitest";
import { sendQuoteConsequences, type QuoteToSend } from "./send-consequences";

const Q: QuoteToSend = {
  id: "Q-ADPL-2026-27-0042",
  customerName: "Kailash Corporation",
  recipientEmail: "ravi@kailash.in",
  amount: 118_000, subtotal: 100_000, taxRate: 18,
  validityDays: 7, alreadySent: false,
};
const text = (l: { text: string }[]) => l.map((c) => c.text).join(" | ");

describe("R-1679: sending a quote whose validity has ended", () => {
  it("warns that the accept link will refuse it — never 'Valid for −1 days'", () => {
    const l = sendQuoteConsequences({ ...Q, validityDays: -1 });
    expect(text(l.filter((c) => c.tone === "warning"))).toMatch(/validity has already ended/);
    expect(text(l)).not.toMatch(/Valid for -?\d/);
    expect(text(l)).not.toMatch(/no validity period/);
  });
});
const warns = (l: { tone: string; text: string }[]) => l.filter((c) => c.tone === "warning");

describe("sendQuoteConsequences", () => {
  it("says the money goes to a named person and cannot be recalled", () => {
    const t = text(sendQuoteConsequences(Q));
    expect(t).toContain("₹1,18,000");
    expect(t).toContain("Kailash Corporation");
    expect(t).toContain("ravi@kailash.in");
    expect(t).toMatch(/cannot be recalled/i);
  });

  it("says the accept link works without the operator", () => {
    /* The old copy called this "included automatically", which reads as a convenience
       rather than "they can commit you at 2am". */
    expect(text(sendQuoteConsequences(Q))).toMatch(/without you/i);
  });

  it("catches a total that disagrees with its own GST, before the customer sees it", () => {
    /* This check existed only on the INVOICE path, added 21 Aug 2026 after finding one
       production quote under-charged by 8,165. Sending happens FIRST in the real
       sequence, so the wrong figure reached the customer before anything looked at it —
       and by then it is quoted, not merely stored. */
    const bad = { ...Q, subtotal: 100_000, taxRate: 18, amount: 100_000 };
    const w = warns(sendQuoteConsequences(bad));
    expect(w.length).toBeGreaterThan(0);
    expect(text(w)).toContain("₹18,000");
    expect(text(w)).toMatch(/hold you to/i);
  });

  it("stays quiet about GST when the numbers agree", () => {
    expect(text(sendQuoteConsequences(Q))).not.toMatch(/does not match its own GST/i);
  });

  it("warns that a resend leaves TWO prices in the thread", () => {
    /* The word "Resend" made this sound like a correction. The earlier email does not
       disappear, and the customer chooses which one they read. */
    const w = warns(sendQuoteConsequences({ ...Q, alreadySent: true }));
    expect(text(w)).toMatch(/two prices/i);
    expect(text(w)).toMatch(/still in their inbox/i);
  });

  it("says nothing about resending on a first send", () => {
    expect(text(sendQuoteConsequences(Q))).not.toMatch(/two prices/i);
  });

  it("treats a missing validity as commercial exposure, not a missing field", () => {
    const w = warns(sendQuoteConsequences({ ...Q, validityDays: null }));
    expect(text(w)).toMatch(/stands indefinitely/i);
    expect(text(w)).toMatch(/cost changes/i);
  });

  it("states the validity when the quote has one, with the right plural", () => {
    expect(text(sendQuoteConsequences(Q))).toMatch(/Valid for 7 days/);
    expect(text(sendQuoteConsequences({ ...Q, validityDays: 1 }))).toMatch(/Valid for 1 day\b/);
  });

  it("blocks a quote with no total", () => {
    const w = warns(sendQuoteConsequences({ ...Q, amount: 0 }));
    expect(text(w)).toMatch(/nothing for the customer to accept/i);
  });

  it("blocks a send with no recipient", () => {
    for (const v of [null, "", "   "]) {
      const w = warns(sendQuoteConsequences({ ...Q, recipientEmail: v }));
      expect(text(w), String(v)).toMatch(/No recipient address/i);
    }
  });

  it("reads sensibly when the customer name is missing", () => {
    const t = text(sendQuoteConsequences({ ...Q, customerName: null }));
    expect(t).toContain("the customer");
    expect(t).not.toContain("null");
  });
});
