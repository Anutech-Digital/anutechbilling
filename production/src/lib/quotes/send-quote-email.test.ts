// R-408 (7 Oct 2026, Abhishek's audit): "Save & send quote" only set status = 'sent' —
// Q-DEMO-27-0001 was 'sent' with 0 rows in email_log. These tests pin the three cases:
// (1) customer has an email → save as draft + email through the ONE send path,
// (2) no email → button says "Save & mark sent" and the toast says no email went,
// (3) the email fails → not shown as emailed, error shown, retry kept.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sendQuoteEmail, quoteRecipient, saveAndSendPlan, saveAndSendLabel,
  quoteEmailOutcome, quoteEmailErrorOutcome, markedSentOutcome, needsApprovalOutcome,
  type SendQuoteEmailResult,
} from "./send-quote-email";

const ok = (over: Partial<SendQuoteEmailResult> = {}): SendQuoteEmailResult => ({
  status: "sent", email_mode: "real", providerId: "p1", errorMessage: null,
  recipient: "ravi@acme.in", attachedPdf: true, quoteStatus: "sent", ...over,
});

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("case 1 — customer has an email: Save & send emails it", () => {
  it("plans an email and keeps the honest label", () => {
    const plan = saveAndSendPlan({ recipient: quoteRecipient(" ravi@acme.in "), sendAllowed: true });
    expect(plan).toBe("email");
    expect(saveAndSendLabel(plan)).toEqual({ full: "Save & send quote", short: "Save & send" });
  });

  it("POSTs to the same route the Send via email sheet uses, with the recipient", async () => {
    const f = fakeFetch(200, ok());
    const res = await sendQuoteEmail("Q-DEMO-27-0001", { to: " ravi@acme.in " }, f);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/quotes/Q-DEMO-27-0001/send");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ to: "ravi@acme.in" });
    expect(res.status).toBe("sent");
  });

  it("toast names the address", () => {
    const out = quoteEmailOutcome(ok(), { quoteId: "Q-1" });
    expect(out.ok).toBe(true);
    expect(out.title).toBe("Quote sent to ravi@acme.in");
  });

  it("the builder saves a DRAFT first and emails via sendQuoteEmail (route flips to sent)", () => {
    const src = readFileSync(join(process.cwd(), "src/components/features/quotes/quote-builder.tsx"), "utf8");
    // main button + Ctrl+Enter go through the send-now path, not a bare status flip
    expect(src).toMatch(/onClick=\{\(\) => handleSubmit\("sent", "send-now"\)\}/);
    expect(src).toMatch(/handleSubmitRef\.current\("sent", "send-now"\)/);
    expect(src).not.toMatch(/void handleSubmit\("sent"\);/);
    expect(src).toMatch(/plan === "email" \|\| plan === "needs-approval" \? "draft" : status/);
    expect(src).toMatch(/status:\s+saveStatus,/);
    expect(src).toMatch(/await sendQuoteEmail\(id, \{ to \}\)/);
    // and the sheet uses the very same function — one path, not a copy
    const sheet = readFileSync(join(process.cwd(), "src/components/features/quotes/send-quote-dialog.tsx"), "utf8");
    expect(sheet).toMatch(/sendQuoteEmail\(quoteId,/);
    expect(sheet).not.toMatch(/fetch\(`\/api\/quotes/);
  });
});

describe("case 2 — no customer email: say so plainly", () => {
  it("plans mark-sent and the button says Save & mark sent", () => {
    for (const e of [null, undefined, "", "  ", "not-an-email"]) {
      expect(quoteRecipient(e)).toBeNull();
    }
    const plan = saveAndSendPlan({ recipient: null, sendAllowed: true });
    expect(plan).toBe("mark-sent");
    expect(saveAndSendLabel(plan).full).toBe("Save & mark sent");
  });

  it("toast says no email went and how to send it", () => {
    const out = markedSentOutcome("Q-2");
    expect(out.title).toBe("Q-2 marked sent — no email went");
    expect(out.description).toMatch(/Send via email/);
  });

  it("a quote that needs approval is never emailed from the builder", () => {
    expect(saveAndSendPlan({ recipient: "ravi@acme.in", sendAllowed: false })).toBe("needs-approval");
    expect(needsApprovalOutcome("Q-3").description).toMatch(/Nothing was emailed/);
  });
});

describe("case 3 — the email fails: not shown as emailed, retry kept", () => {
  it("a provider failure is not ok and says the quote is still a draft", () => {
    const out = quoteEmailOutcome(ok({ status: "failed", errorMessage: "Mailbox not connected", quoteStatus: "draft" }), { quoteId: "Q-4" });
    expect(out.ok).toBe(false);
    expect(out.title).toBe("Email did not go to ravi@acme.in");
    expect(out.description).toBe("Mailbox not connected. The quote is saved as a draft — try again.");
  });

  it("a 4xx/5xx throws the server's own words", async () => {
    const f = fakeFetch(400, { error: "no valid recipient — set customer contact email or pass `to`" });
    await expect(sendQuoteEmail("Q-5", { to: "x@y.in" }, f)).rejects.toThrow(/no valid recipient/);
    const out = quoteEmailErrorOutcome(new Error("Network down"));
    expect(out.ok).toBe(false);
    expect(out.description).toBe("Network down. The quote is saved as a draft — try again.");
    expect(quoteEmailErrorOutcome(new Error("x"), { alreadySent: true }).description).toBe("x. Nothing was sent — try again.");
  });

  it("the builder stays on the page and offers Try again", () => {
    const src = readFileSync(join(process.cwd(), "src/components/features/quotes/quote-builder.tsx"), "utf8");
    expect(src).toMatch(/if \(emailFailed\) return;/);
    expect(src).toMatch(/label: "Try again"/);
  });

  it("a stubbed send (no email server) does not claim a real email", () => {
    const out = quoteEmailOutcome(ok({ status: "stubbed", email_mode: "stub" }), { quoteId: "Q-6" });
    expect(out.title).toMatch(/no real email/);
  });
});
