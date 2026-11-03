/**
 * R-2448 — a Send refused for a missing place of supply (R-2442: 409 + nextStep) must reach the
 * toast as the button that fixes it, and must not end with "try again" (a retry is refused the
 * same way). sendQuoteEmail used to keep only json.error, so the button was lost.
 */
import { describe, it, expect, vi } from "vitest";
import {
  sendQuoteEmail, quoteEmailErrorOutcome, failedSendButtons, QuoteSendRefusedError,
} from "./send-quote-email";
import { markQuoteSent } from "./mark-quote-sent";

const CUSTOMER = "33333333-3333-4333-8333-333333333333";
const refusal = {
  error: "Pathak Fabrication has no state on record — the state decides CGST + SGST or IGST. Set the customer's state on the customer page, then send",
  nextStep: { label: "Set the customer's state", href: `/customers/${CUSTOMER}` },
};

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("sendQuoteEmail keeps the route's next step (R-2448)", () => {
  it("409 + nextStep → throws a QuoteSendRefusedError carrying status and nextStep", async () => {
    const err = await sendQuoteEmail("Q-1", {}, fakeFetch(409, refusal)).catch((e) => e);
    expect(err).toBeInstanceOf(QuoteSendRefusedError);
    expect(err.message).toBe(refusal.error);
    expect(err.status).toBe(409);
    expect(err.nextStep).toEqual(refusal.nextStep);
  });

  it("a next step that is not an in-app path is dropped (no open redirect from a response body)", async () => {
    for (const href of ["https://evil.example/x", "//evil.example", "javascript:alert(1)", "/\\evil.example"]) {
      const err = await sendQuoteEmail("Q-1", {}, fakeFetch(409, { error: "x", nextStep: { label: "Go", href } })).catch((e) => e);
      expect(err.nextStep).toBeUndefined();
    }
  });

  it("the toast: no 'try again' on a 409, the next step is the button", () => {
    const err = new QuoteSendRefusedError(refusal.error, 409, refusal.nextStep);
    const draft = quoteEmailErrorOutcome(err);
    expect(draft.description).toBe(`${refusal.error}. The quote is saved as a draft.`);
    expect(draft.description).not.toMatch(/try again/i);
    expect(draft.nextStep).toEqual(refusal.nextStep);
    expect(draft.noRetry).toBe(true);
    const resent = quoteEmailErrorOutcome(err, { alreadySent: true });
    expect(resent.description).toBe(`${refusal.error}. Nothing was sent.`);

    const b = failedSendButtons(null, { role: "owner", quoteId: "Q-1", nextStep: draft.nextStep });
    expect(b.primary).toEqual({ kind: "next-step", label: "Set the customer's state", href: `/customers/${CUSTOMER}` });
    expect(b.secondary).toBeUndefined();
  });

  it("a network / 5xx failure still offers 'try again'", () => {
    const out = quoteEmailErrorOutcome(new Error("Send failed (502)"));
    expect(out.description).toMatch(/try again/);
    expect(out.noRetry).toBeFalsy();
    expect(failedSendButtons(null, { role: "owner", quoteId: "Q-1" }).primary.kind).toBe("retry");
  });
});

describe("markQuoteSent keeps the same next step (Mark as sent / Copy link / WhatsApp)", () => {
  it("409 + nextStep → QuoteSendRefusedError with the button", async () => {
    const err = await markQuoteSent("Q-1", fakeFetch(409, refusal)).catch((e) => e);
    expect(err).toBeInstanceOf(QuoteSendRefusedError);
    expect(err.message).toBe(refusal.error);
    expect(err.nextStep).toEqual(refusal.nextStep);
  });
});
