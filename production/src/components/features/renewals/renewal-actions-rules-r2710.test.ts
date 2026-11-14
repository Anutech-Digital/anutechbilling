/**
 * R-2710 — Pratik (Excel renewals, 12 Nov): "renewal button daba ne pr editable usme khul na
 * chahiye". He pressed "Send renewal quote" → confirm → the quote was emailed before he ever saw
 * it. The row's one button now opens the renewal quote in the editor; the fast path ("Send as is")
 * and "Resend" sit in ⋯. Split-billed rows and roles without the quote editor are unchanged.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  renewalActionSet, renewalNextStep,
  REVIEW_RENEWAL_QUOTE, CHANGE_RENEWAL_QUOTE, SEND_AS_IS, RESEND_RENEWAL_QUOTE, SEND_RENEWAL_QUOTE,
  CREATE_QUOTE_NO_SEND, BILL_RENEWAL_YEAR,
  type RenewalActionSub,
} from "./renewal-actions-rules";

const sub = (p: Partial<RenewalActionSub> = {}): RenewalActionSub => ({
  id: "s1", renewal_state: "notice_sent", renewal_date: "2026-11-30", term_months: 12, status: "active",
  auto_renew: true, renewal_quote_id: null, billing_cycle: "yearly", grace_until: null, ...p,
});
const RENEWALS_USER = { tenantGraceDays: 15, canEndSubscription: true, canReview: true };
const ROW = { followup: true, messaging: true };

describe("R-2710 the row button opens the renewal quote first", () => {
  it("Pratik's row (8–30 days, annual, no quote yet): Review renewal quote; ⋯ Send as is (no changes)", () => {
    const set = renewalActionSet(sub(), null, { ...RENEWALS_USER, daysUntil: 18 });
    expect(set.primary).toEqual({ kind: "review", label: REVIEW_RENEWAL_QUOTE });
    expect(set.secondary).toEqual({ kind: "send-now", label: SEND_AS_IS });
    const step = renewalNextStep(set, ROW);
    expect(step.button).toEqual({ kind: "review", label: "Review renewal quote" });
    expect(step.menu).toEqual(["secondary", "followup", "nudge", "voice", "not-renewing"]);
    expect(SEND_AS_IS).toBe("Send as is (no changes)");
  });

  it("a draft renewal quote (made, not sent): Review it again — never a second quote", () => {
    const set = renewalActionSet(sub({ renewal_quote_id: "Q-1" }), "draft", { ...RENEWALS_USER, daysUntil: 10 });
    expect(set.primary).toEqual({ kind: "review", label: REVIEW_RENEWAL_QUOTE });
    expect(set.secondary?.kind).toBe("send-now");
    expect(set.row.text).toMatch(/Renewal quote Q-1 not sent yet/);
  });

  it("sent / viewed and unpaid: Change renewal quote (Revise); ⋯ Resend renewal quote", () => {
    for (const status of ["sent", "viewed"]) {
      const set = renewalActionSet(sub({ renewal_quote_id: "Q-1" }), status, { ...RENEWALS_USER, daysUntil: 10 });
      expect(set.primary).toEqual({ kind: "change", label: CHANGE_RENEWAL_QUOTE });
      expect(set.secondary).toEqual({ kind: "send-now", label: RESEND_RENEWAL_QUOTE });
      expect(set.row.text).toMatch(/Renewal sent Q-1/);
    }
  });

  it("accepted (Revise is refused there) or status not loaded: Resend as before, nothing in ⋯", () => {
    for (const status of ["accepted", null]) {
      const set = renewalActionSet(sub({ renewal_quote_id: "Q-1" }), status, { ...RENEWALS_USER, daysUntil: 10 });
      expect(set.primary).toEqual({ kind: "send-now", label: RESEND_RENEWAL_QUOTE });
      expect(set.secondary).toBeNull();
    }
  });

  it("billed in parts: unchanged — Bill renewal / Bill next part, never Review (that route would BILL the part)", () => {
    const set = renewalActionSet(sub({ billing_cycle: "quarterly" }), null, { ...RENEWALS_USER, daysUntil: 5 });
    expect(set.primary).toEqual({ kind: "generate", label: BILL_RENEWAL_YEAR });
    expect(set.secondary).toBeNull();
    const withQuote = renewalActionSet(sub({ billing_cycle: "quarterly", renewal_quote_id: "Q-1" }), "sent", { ...RENEWALS_USER, daysUntil: 5 });
    expect(withQuote.primary?.kind).toBe("send-now");
  });

  it("a role that cannot open the quote editor keeps the old Send renewal quote / Create quote", () => {
    const set = renewalActionSet(sub(), null, { ...RENEWALS_USER, canReview: false, daysUntil: 18 });
    expect(set.primary).toEqual({ kind: "send-now", label: SEND_RENEWAL_QUOTE });
    expect(set.secondary).toEqual({ kind: "generate", label: CREATE_QUOTE_NO_SEND });
  });

  it("renewed / Won't renew: still nothing to review", () => {
    expect(renewalActionSet(sub({ auto_renew: false }), null, { ...RENEWALS_USER, daysUntil: 3 }).primary).toBeNull();
    expect(renewalActionSet(sub({ renewal_state: "renewed", renewal_date: "2027-11-30" }), null, { ...RENEWALS_USER, daysUntil: 380 }).primary).toBeNull();
  });
});

describe("R-2710 wiring", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("Review asks the generate route for a DRAFT and opens the editor; Change goes through the shared Revise", () => {
    const src = read("src/components/features/renewals/renewal-actions.tsx");
    expect(src).toMatch(/JSON\.stringify\(\{ review: true \}\)/);
    /* R-2754: the editor link carries ?returnTo=<this Renewals tab> (lib/renewals/back-to-renewals.ts). */
    expect(src).toMatch(/quoteEditHrefFromRenewals\(json\.quoteId, from\)/);
    expect(src).toMatch(/openRenewalRevision\(/);
    expect(src).toMatch(/canReview: canQuotes/);
  });
  it("the generate route: review → status draft; a split-billed subscription is refused before the part-billing path", () => {
    const src = read("src/app/api/subscriptions/[id]/generate-renewal-quote/route.ts");
    const refuse = src.indexOf("if (splitReason && review)");
    const bill = src.indexOf("if (splitReason) {");
    expect(refuse).toBeGreaterThan(0);
    expect(refuse).toBeLessThan(bill);
    expect(src).toMatch(/review \? \{ status: "draft" as const \}/);
  });
  it("the editor of a renewal quote has ONE 'Save & send to customer' button (the usual R-408 send; its label never promises an email it will not send)", () => {
    const src = read("src/components/features/quotes/quote-builder.tsx");
    expect(src).toMatch(/email: "Save & send to customer", "mark-sent": "Save & mark sent", "needs-approval": "Save & ask for approval"/);
    expect(src).toMatch(/data-renewal-send[\s\S]{0,200}onClick=\{\(\) => void handleSubmit\("sent", "send-now"\)\}/);
  });
  it("Review never moves renewal_state (the T-15 notice still goes); a domain is priced live as the cron does", () => {
    const src = read("src/app/api/subscriptions/[id]/generate-renewal-quote/route.ts");
    expect(src).toMatch(/result\.created && sub\.renewal_state === "pending" && !review/);
    expect(src).toMatch(/review && sub\.vendor === "domain" && sub\.domain\s*\?\s*await createDomainRenewalQuote\(/);
  });
  it("the cron and Send now gate a DRAFT renewal quote (approval) before emailing it, and mark it sent only after the email went", () => {
    for (const p of ["src/app/api/cron/renewals/route.ts", "src/app/api/renewals/send-now/route.ts"]) {
      const src = read(p);
      const gate = src.indexOf("draftRenewalQuoteBlock(supabase");
      const send = src.indexOf("sendCustomerEmail({");
      const mark = src.indexOf("markRenewalQuoteSent(supabase");
      expect(gate, p).toBeGreaterThan(0);
      expect(gate, p).toBeLessThan(send);
      expect(mark, p).toBeGreaterThan(send);
    }
  });
  it("the quote page's Revise and the Renewals Change use the same insertRevision", () => {
    expect(read("src/app/(app)/quotes/[id]/page.tsx")).toMatch(/insertRevision\(/);
  });
});
