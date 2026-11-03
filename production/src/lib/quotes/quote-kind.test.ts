import { describe, expect, it } from "vitest";
import { dayMonYear, partMonths, partsInTerm, partText, quoteKindFor, quoteSubscriptionId, subscriptionForLine, type QuotePartFacts } from "./quote-kind";

/* Pardeep's staging case (3 Nov 2026, Q-A378-27-0930): an old customer's subscription, billed
   monthly, renewed on 1 Nov 2026 — the request for month 1 of the new term. */
const renewalPart: QuotePartFacts = {
  periodIndex: 1, periodStart: "2026-11-01", periodEnd: "2026-12-01", termStart: "2026-11-01",
  subStartDate: "2024-11-01", firstTermStart: "2025-11-01", subQuoteId: null,
  billingCycle: "monthly", termMonths: 12,
};
const partQuote = { subscription_billing_id: "b-1", is_one_off: true, payment_status: "awaiting", amount: 1180, payment_amount: 0 };

describe("quoteKindFor — part payment requests (R-2044)", () => {
  it("Q-A378-27-0930: RENEWAL · Part 1 of 12 · Nov 2026", () => {
    const s = quoteKindFor(partQuote, renewalPart);
    expect(s?.text).toBe("RENEWAL · Part 1 of 12 · Nov 2026");
    expect(s?.kind).toBe("renewal");
    expect(s?.chip).toBe("Renewal");
    expect(s?.partShort).toBe("Part 1 of 12");
    expect(s?.paid).toBe(false);
  });

  it("after Record payment: RENEWAL · Part 1 of 12 · Nov 2026 · PAID 3 Nov 2026", () => {
    const s = quoteKindFor({ ...partQuote, payment_status: "received", payment_amount: 1180, payment_received_at: "2026-11-03T09:12:00Z" }, renewalPart);
    expect(s?.text).toBe("RENEWAL · Part 1 of 12 · Nov 2026 · PAID 3 Nov 2026");
    expect(s?.paidOn).toBe("3 Nov 2026");
  });

  it("invoiced but unpaid is not PAID (quoteIsPaid)", () => {
    expect(quoteKindFor({ ...partQuote, payment_status: "invoiced", payment_amount: 0 }, renewalPart)?.paid).toBe(false);
  });

  it("a later part of the FIRST term of a sale made in this app = NEW SALE", () => {
    const s = quoteKindFor(partQuote, {
      ...renewalPart, periodIndex: 2, periodStart: "2026-12-01", periodEnd: "2027-01-01",
      termStart: "2026-11-01", subStartDate: "2026-11-01", firstTermStart: "2026-11-01", subQuoteId: "Q-1",
    });
    expect(s?.text).toBe("NEW SALE · Part 2 of 12 · Dec 2026");
  });

  it("first term of an imported subscription (no sale quote): only the part, no kind word", () => {
    const s = quoteKindFor(partQuote, { ...renewalPart, subStartDate: "2026-11-01", firstTermStart: "2026-11-01" });
    expect(s?.kind).toBeNull();
    expect(s?.word).toBeNull();
    expect(s?.text).toBe("Part 1 of 12 · Nov 2026");
  });

  it("quarterly part shows its months; a term that does not divide shows no 'of N'", () => {
    expect(partText({ ...renewalPart, billingCycle: "quarterly", periodEnd: "2027-02-01" })).toBe("Part 1 of 4 · Nov 2026–Jan 2027");
    expect(partText({ ...renewalPart, billingCycle: "quarterly", termMonths: 10, periodEnd: "2027-02-01" })).toBe("Part 1 · Nov 2026–Jan 2027");
  });

  it("part not loaded → no stamp (never a guess)", () => {
    expect(quoteKindFor(partQuote, null)).toBeNull();
  });
});

describe("quoteKindFor — quotes by their own flags", () => {
  const line = { name: "Workspace", rate: 100, qty: 1 };
  it("renewal / add seats / extension / one-time / new sale", () => {
    expect(quoteKindFor({ is_renewal: true, line_items: [line] })?.word).toBe("RENEWAL");
    expect(quoteKindFor({ renewal_subscription_id: "s1", line_items: [line] })?.word).toBe("RENEWAL");
    expect(quoteKindFor({ is_add_seats: true, line_items: [line] })?.word).toBe("ADD SEATS");
    expect(quoteKindFor({ is_extension: true, extension_months: 3, line_items: [line] })?.word).toBe("EXTENSION");
    expect(quoteKindFor({ is_one_off: true, line_items: [line] })?.word).toBe("ONE-TIME");
    expect(quoteKindFor({ line_items: [{ ...line, one_time: true }] })?.word).toBe("ONE-TIME");
    expect(quoteKindFor({ line_items: [line, { ...line, one_time: true }] })?.word).toBe("NEW SALE");
  });

  it("a support-plan upgrade (stored as is_renewal) is UPGRADE, not RENEWAL (R-2093)", () => {
    expect(quoteKindFor({ is_renewal: true, extension_months: 0, line_items: [{ ...line, item_id: "SUP-ENT-Y" }] })?.word).toBe("UPGRADE");
  });

  it("no lines and no flag → no stamp", () => {
    expect(quoteKindFor({ line_items: [] })).toBeNull();
    /* A customer-advance holder (is_one_off, no lines) sells nothing. */
    expect(quoteKindFor({ is_one_off: true, line_items: [] })).toBeNull();
    expect(quoteKindFor({})).toBeNull();
    expect(quoteKindFor(null)).toBeNull();
  });

  it("paid new sale with no stored date → PAID without a date", () => {
    expect(quoteKindFor({ line_items: [line], payment_status: "received", amount: 100, payment_amount: 100 })?.text).toBe("NEW SALE · PAID");
  });
});

describe("helpers", () => {
  it("dates and months", () => {
    expect(dayMonYear("2026-11-03")).toBe("3 Nov 2026");
    expect(dayMonYear(null)).toBeNull();
    /* A payment at 01:30 IST on 3 Nov is stored as 2 Nov UTC — the stamp says the IST day. */
    expect(dayMonYear("2026-11-02T20:00:00+00:00")).toBe("3 Nov 2026");
    expect(partMonths("2026-11-01", "2026-12-01")).toBe("Nov 2026");
    expect(partMonths("2026-11-01", "2027-01-01")).toBe("Nov–Dec 2026");
    /* A part not starting on the 1st shows its days — one month never reads as two. */
    expect(partMonths("2026-11-15", "2026-12-15")).toBe("15 Nov–14 Dec 2026");
    expect(partMonths("2027-02-28", "2027-03-31")).toBe("28 Feb–30 Mar 2027");
    expect(partMonths("2026-12-15", "2027-01-15")).toBe("15 Dec 2026–14 Jan 2027");
    expect(partsInTerm("monthly", 12)).toBe(12);
    expect(partsInTerm("half_yearly", 12)).toBe(2);
    expect(partsInTerm(null, 12)).toBeNull();
  });

  it("subscription line", () => {
    expect(subscriptionForLine({ plan: "Google Workspace Business Starter", domain: "acme.in", seats: 12, renewal_date: "2027-10-31" }))
      .toBe("Google Workspace Business Starter · acme.in · 12 seats · renews 31 Oct 2027");
    expect(subscriptionForLine({ plan: "Plan", seats: 1 })).toBe("Plan · 1 seat");
    expect(subscriptionForLine(null)).toBeNull();
  });

  it("which subscription the quote is for", () => {
    const subs = [
      { id: "s2", quote_id: "Q-1", created_at: "2026-02-01" },
      { id: "s1", quote_id: "Q-1", created_at: "2026-01-01" },
      { id: "s3", renewal_quote_id: "Q-2" },
    ];
    expect(quoteSubscriptionId({ id: "Q-1" }, subs)).toBe("s1");
    expect(quoteSubscriptionId({ id: "Q-2" }, subs)).toBe("s3");
    expect(quoteSubscriptionId({ id: "Q-3", renewal_subscription_id: "s9" }, subs)).toBe("s9");
    expect(quoteSubscriptionId({ id: "Q-4", is_add_seats: true, add_seats_subscription_id: "s7" }, subs)).toBe("s7");
    expect(quoteSubscriptionId({ id: "Q-5", subscription_billing_id: "b" }, subs, "s5")).toBe("s5");
    expect(quoteSubscriptionId({ id: "Q-6", subscription_billing_id: "b" }, subs)).toBeNull();
  });
});
