/**
 * R-018 — an overdue reminder either carries a real way to pay, or does not claim to.
 *
 * The bug was not a broken link. It was a message that PROMISED one while the caller
 * passed null on every run, for months, with no error anywhere. So the assertions that
 * matter most here are about the SENTENCE, not the URL.
 */
import { describe, it, expect } from "vitest";
import { upiPayLink, payInstruction } from "./pay-link";
import { dunningMessage } from "./dunning";

const base = { upiVpa: "anutech@hdfcbank", payeeName: "ANUTECH DIGITAL", amountDue: 55885, invoiceId: "INV-ADPL-2026-27-0002" };

describe("upiPayLink", () => {
  it("builds a upi://pay link with the amount and the invoice on it", () => {
    const url = upiPayLink(base);
    expect(url).toContain("upi://pay?");
    expect(url).toContain("pa=anutech%40hdfcbank");
    expect(url).toContain("am=55885");
    expect(url).toContain("cu=INR");
    /* The note reaches the reseller's bank statement, which is what makes the receipt
       reconcilable later. */
    expect(url).toContain("INV-ADPL-2026-27-0002");
  });

  it("returns null when the tenant has no VPA", () => {
    expect(upiPayLink({ ...base, upiVpa: null })).toBeNull();
    expect(upiPayLink({ ...base, upiVpa: "   " })).toBeNull();
  });

  it("refuses a half-filled VPA rather than shipping a dead deep link", () => {
    /* A malformed VPA opens the payer's app and then says "invalid UPI ID" — worse
       than no link, because the customer believes they tried and we did not. */
    expect(upiPayLink({ ...base, upiVpa: "anutech" })).toBeNull();
    expect(upiPayLink({ ...base, upiVpa: "@hdfcbank" })).toBeNull();
  });

  it("refuses a zero or negative amount", () => {
    // Nothing is owed, or the figure is broken. Neither is a payment request.
    expect(upiPayLink({ ...base, amountDue: 0 })).toBeNull();
    expect(upiPayLink({ ...base, amountDue: -100 })).toBeNull();
  });

  it("falls back to a placeholder payee rather than sending an empty name", () => {
    expect(upiPayLink({ ...base, payeeName: null })).toContain("pn=Payee");
  });
});

describe("payInstruction — the sentence", () => {
  it("asks for a reply when there is no link, and never says 'link below'", () => {
    const s = payInstruction(null);
    expect(s).toMatch(/reply/i);
    expect(s.toLowerCase()).not.toContain("link below");
    expect(s.toLowerCase()).not.toContain("here's the link");
  });

  it("says UPI needs a phone", () => {
    /* A upi:// link does nothing in a desktop browser. A customer who clicks it there
       concludes the link is broken and stops trying. */
    expect(payInstruction("upi://pay?pa=x@y")).toMatch(/phone/i);
  });

  it("uses plain wording for an ordinary https link", () => {
    expect(payInstruction("https://rzp.io/i/abc")).toContain("Pay here: https://rzp.io/i/abc");
  });
});

describe("dunningMessage — no step may promise a link it does not have", () => {
  const steps = ["pre_due", "due_today", "reminder", "retry", "grace_warning", "final"] as const;
  const args = {
    invoiceId: "INV-1", customerName: "Beta Co", amountDue: "₹55,885",
    dueDate: "19 Aug 2026", sellerName: "ANUTECH DIGITAL",
  };

  it.each(steps)("%s says nothing about a link when there is none", (step) => {
    /* THE BUG, pinned per step. `retry` said "here's the link again", `grace_warning`
       and `final` said "pay using the link below" — all three with payLink null. */
    const msg = dunningMessage({ ...args, step, payLink: null });
    const body = `${msg?.subject ?? ""} ${msg?.text ?? ""}`.toLowerCase();
    expect(body).not.toContain("link below");
    expect(body).not.toContain("here's the link");
    expect(body).not.toContain("payment link");
  });

  it.each(steps)("%s carries the link when there IS one", (step) => {
    const msg = dunningMessage({ ...args, step, payLink: "upi://pay?pa=anutech%40hdfcbank&am=55885" });
    expect(msg?.text).toContain("upi://pay?pa=anutech%40hdfcbank");
  });

  it("still reads as a whole sentence without the link clause", () => {
    // A conditional clause spliced out badly leaves "so please tell us" or a double space.
    const msg = dunningMessage({ ...args, step: "grace_warning", payLink: null });
    expect(msg?.text).toContain("so please tell us what's holding it up");
    expect(msg?.text).not.toMatch(/ {2}/);
  });

  it("keeps the retry subject honest too, not just the body", () => {
    /* The subject line said "payment link" — the customer reads that in the inbox
       before opening anything. */
    expect(dunningMessage({ ...args, step: "retry", payLink: null })?.subject)
      .toBe("Invoice INV-1 — still showing as unpaid");
    expect(dunningMessage({ ...args, step: "retry", payLink: "upi://pay?pa=x%40y&am=1" })?.subject)
      .toContain("payment link");
  });
});
