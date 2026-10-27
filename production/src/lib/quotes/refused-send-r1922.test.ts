// R-1922 (G-ONBOARD OB-1, 25 Oct 2026): a brand-new company's first "Save & send" was refused
// ("Customer messages are switched off") and the toast offered only "Try again" — no way to
// fix it, no other way to reach the customer. Copy customer link sat hidden under More.
// Pinned here:
//   - a refused email names the reason AND gives the button that fixes it:
//     owner → "Turn on customer messages" (the exact switch on /automation) + "Copy link instead";
//     anyone else → "ask the owner" + "Copy link instead" + "Open quote" (Send on WhatsApp is there);
//   - any other failure keeps "Try again" and still offers "Copy link instead";
//   - the send route tells the client WHY (refusedReason) and hands back the customer link;
//   - Copy customer link is a visible button on the quote page, not a More menu item.
// The "new company starts ON" half is SQL: supabase/tests/new_company_customer_messages_on.test.sql.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  quoteEmailOutcome, failedSendButtons, CUSTOMER_MESSAGES_SWITCH_HREF,
  type SendQuoteEmailResult,
} from "./send-quote-email";

const LINK = "https://app.example.in/quote/Q-1/accept?t=tok";
const refused = (over: Partial<SendQuoteEmailResult> = {}): SendQuoteEmailResult => ({
  status: "failed", email_mode: "real", providerId: null,
  errorMessage: "Customer messages are switched off for this company. The owner can turn them on in Automation.",
  recipient: "ravi@acme.in", attachedPdf: true, quoteStatus: "draft",
  refusedReason: "customer_messages_off", customerLink: LINK, ...over,
});
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("R-1922: a refused email shows the reason and a button that fixes it", () => {
  it("the toast says why, that nothing is lost, and the other ways to reach the customer", () => {
    const out = quoteEmailOutcome(refused(), { quoteId: "Q-1" });
    expect(out.ok).toBe(false);
    expect(out.title).toBe("Email did not go to ravi@acme.in");
    expect(out.description).toBe(
      "Customer messages are switched off for this company. The quote is saved as a draft. " +
      "Copy the customer link and share it yourself, or send it on WhatsApp from the quote page.",
    );
  });

  it("owner: Turn on customer messages goes to the exact switch; Copy link instead is the other button", () => {
    const b = failedSendButtons(refused(), { role: "owner", quoteId: "Q-1" });
    expect(b.primary).toEqual({ kind: "turn-on-messages", label: "Turn on customer messages", href: CUSTOMER_MESSAGES_SWITCH_HREF });
    expect(CUSTOMER_MESSAGES_SWITCH_HREF).toBe("/automation#customer-messages");
    expect(b.secondary).toEqual({ kind: "copy-link", label: "Copy link instead", link: LINK });
    expect(b.note).toBeUndefined();
  });

  it("not the owner: no switch they cannot press — ask the owner, copy the link, or open the quote for WhatsApp", () => {
    for (const role of ["manager", "sales", null]) {
      const b = failedSendButtons(refused(), { role, quoteId: "Q-1" });
      expect(b.primary).toEqual({ kind: "copy-link", label: "Copy link instead", link: LINK });
      expect(b.secondary).toEqual({ kind: "open-quote", label: "Open quote", href: "/quotes/Q-1" });
      expect(b.note).toBe("Only the owner can turn on customer messages — ask the owner (Automation → Customer messages).");
    }
  });

  it("not the owner, already on the quote page (Send sheet): Copy link instead only — WhatsApp is right there", () => {
    const b = failedSendButtons(refused(), { role: "manager", quoteId: "Q-1", onQuotePage: true });
    expect(b.primary).toEqual({ kind: "copy-link", label: "Copy link instead", link: LINK });
    expect(b.secondary).toBeUndefined();
    expect(b.note).toMatch(/ask the owner/);
  });

  it("any other failure keeps Try again and still offers the link", () => {
    const b = failedSendButtons(refused({ refusedReason: undefined, errorMessage: "Mailbox not connected" }), { role: "owner", quoteId: "Q-1" });
    expect(b.primary).toEqual({ kind: "retry", label: "Try again" });
    expect(b.secondary).toEqual({ kind: "copy-link", label: "Copy link instead", link: LINK });
    const out = quoteEmailOutcome(refused({ refusedReason: undefined, errorMessage: "Mailbox not connected." }), { quoteId: "Q-1" });
    expect(out.description).toBe("Mailbox not connected. The quote is saved as a draft — try again.");
  });

  it("a request that never reached the server (no link) keeps only Try again", () => {
    const b = failedSendButtons(null, { role: "owner", quoteId: "Q-1" });
    expect(b.primary).toEqual({ kind: "retry", label: "Try again" });
    expect(b.secondary).toBeUndefined();
  });
});

describe("R-1922: wiring", () => {
  it("the send route says why it was refused and returns the customer link", () => {
    const src = read("src/app/api/quotes/[id]/send/route.ts");
    expect(src).toMatch(/sendResult\.errorMessage === CUSTOMER_MESSAGES_OFF/);
    expect(src).toMatch(/refusedReason:/);
    expect(src).toMatch(/customerLink:/);
  });

  it("both send places (builder Save & send, quote page Send via email) use the same buttons", () => {
    expect(read("src/components/features/quotes/quote-builder.tsx")).toMatch(/showFailedSendToast\(\{[\s\S]*?onRetry:/);
    expect(read("src/components/features/quotes/send-quote-dialog.tsx")).toMatch(/showFailedSendToast\(\{[\s\S]*?onQuotePage: true/);
    expect(read("src/components/features/quotes/failed-send-toast.ts")).toMatch(/failedSendButtons\(/);
  });

  it("/automation has the anchor the button goes to, on the Customer messages switch card", () => {
    const src = read("src/app/(app)/automation/scheduled-jobs.tsx");
    const at = src.indexOf('id="customer-messages"');
    expect(at).toBeGreaterThan(0);
    expect(src.indexOf('aria-label="Customer messages on or off"', at)).toBeGreaterThan(at);
  });

  it("quote page: Copy customer link is a visible button next to Send on WhatsApp, not under More", () => {
    const src = read("src/app/(app)/quotes/[id]/page.tsx");
    const wa = src.search(/Send on WhatsApp\r?\n/);
    const copy = src.indexOf("Copy customer link");
    const more = src.indexOf('<Button icon="more_h">More</Button>');
    expect(wa).toBeGreaterThan(0);
    expect(copy).toBeGreaterThan(wa);
    expect(copy).toBeLessThan(more);
    expect(src.slice(src.lastIndexOf("<", copy), copy)).toMatch(/^<Button/);
    expect(src.match(/Copy customer link/g)?.length).toBe(1);
  });
});
