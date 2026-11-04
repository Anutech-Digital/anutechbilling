/**
 * R-2431 (3): Payment Follow-up lists a flex (monthly-commitment) part once its date has passed
 * unbilled — R-2422 made flex a renewal. Before its date the billing job raises the part's
 * payment request on that date (R-2044), so it is not chased early. The amount is the same one
 * part the Renewals row and tiles show (termAmountOf / queue.ts renewalAmount).
 */
import { describe, it, expect } from "vitest";
import { buildCollectionRows, isFollowUpRenewal, type CollectionRenewalSub, type CollectionsInput } from "@/lib/queries/collections";
import { termAmountOf } from "@/lib/billing/subscription-schedule";

const TODAY = "2026-11-03";
const flex = (p: Partial<CollectionRenewalSub> & { id: string }): CollectionRenewalSub => ({
  customer_id: "c1", customer_name: "Flexy Traders", plan: "Business Starter", domain: "flexy.in", quote_id: "Q-1",
  renewal_quote_id: null, renewal_date: "2026-11-01", renewal_state: "pending", status: "active",
  auto_renew: true, billing_cycle: "monthly", term_months: 1, mrr: 1350, term_amount: null,
  grace_until: null, outstanding_amount: 0, start_date: "2026-08-01", ...p,
});
const input = (renewals: CollectionRenewalSub[]): CollectionsInput => ({
  invoices: [], subscriptions: [], quoteSubscriptions: [], invoicedQuoteIds: new Set(),
  customers: [{ id: "c1", name: "Flexy Traders", display_name: null, account_manager_id: null }],
  followups: [], renewals, renewalQuotes: [],
});

describe("R-2431: overdue flex part on Payment Follow-up", () => {
  it("a flex part 2 days past its date, unbilled, is a Renewal line with one month's amount", () => {
    const rows = buildCollectionRows(input([flex({ id: "f1" })]), TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0].renewals[0]).toMatchObject({
      kind: "renewal", id: "f1", daysOverdue: 2,
      amount: termAmountOf({ mrr: 1350, term_months: 1, term_amount: null }),
    });
  });

  it("an overdue flex part whose state is 'renewed' from the LAST roll is still chased", () => {
    expect(isFollowUpRenewal(flex({ id: "f2", renewal_state: "renewed" }), TODAY)).toBe(true);
  });

  it("a flex part still ahead (its request goes out on its date) is not chased yet", () => {
    expect(isFollowUpRenewal(flex({ id: "f3", renewal_date: "2026-11-05" }), TODAY)).toBe(false);
  });
});
