import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  isOpenSeatQuote, openSeatQuotes, seatQuoteSubscriptionId, seatQuotesForSubscription,
  seatQuotePendingText, addSeatsCount, type SeatQuoteRow,
} from "./seat-quotes-pending";

/* R-1705 — the owner's record (local billing audit, T-A1): Manage seats +1 → Q-F588-27-0031,
   ₹3,813, sent / awaiting, written by addSeats() before R-1705 (link only in the notes). */
const SUB = "ecef869d-0c03-4b19-af8a-bb5843e6a9ae";
const q0031: SeatQuoteRow = {
  id: "Q-F588-27-0031", customer_id: "cust-1", customer_name: "T-A1", plan: "Business Starter", seats: 1,
  amount: 3813, payment_amount: null, status: "sent", payment_status: "awaiting", invoice_id: null,
  is_add_seats: true, superseded_by: null, add_seats_subscription_id: null, add_seats_taken_back_at: null,
  notes: `Seats added from today.\nAdd-seats pro-rata for subscription ${SUB}. Effective date 2026-10-20.`,
};

describe("R-1705: open seat quotes are visible money", () => {
  it("the owner's sent seat quote is open, ₹3,813, on T-A1's subscription (found from the notes)", () => {
    const [o] = openSeatQuotes([q0031]);
    expect(o).toMatchObject({ quoteId: "Q-F588-27-0031", subscriptionId: SUB, pending: 3813, seats: 1 });
    expect(seatQuotePendingText(o)).toBe("Seat quote pending ₹3,813 · +1 seat");
  });

  it("the stored link wins over the notes", () => {
    expect(seatQuoteSubscriptionId({ ...q0031, add_seats_subscription_id: "sub-2" })).toBe("sub-2");
  });

  it("closed ones are not open: rejected/taken back, replaced, invoiced, paid, not a seat quote", () => {
    expect(isOpenSeatQuote({ ...q0031, status: "rejected" })).toBe(false);
    expect(isOpenSeatQuote({ ...q0031, add_seats_taken_back_at: "2026-10-21T03:00:00Z" })).toBe(false);
    expect(isOpenSeatQuote({ ...q0031, superseded_by: "Q-F588-27-0031-R2" })).toBe(false);
    expect(isOpenSeatQuote({ ...q0031, invoice_id: "INV-1" })).toBe(false);
    expect(isOpenSeatQuote({ ...q0031, payment_status: "received", payment_amount: 3813 })).toBe(false);
    expect(isOpenSeatQuote({ ...q0031, is_add_seats: false })).toBe(false);
    expect(isOpenSeatQuote({ ...q0031, status: "draft" })).toBe(false);
  });

  it("part paid shows what is still asked", () => {
    expect(openSeatQuotes([{ ...q0031, payment_status: "partial", payment_amount: 1000 }])[0].pending).toBe(2813);
  });

  it("per subscription, keyed by the quote's own link — not by customer", () => {
    const other = { ...q0031, id: "Q-2", notes: null, add_seats_subscription_id: "sub-other" };
    const list = openSeatQuotes([q0031, other]);
    expect(seatQuotesForSubscription(list, SUB).map((q) => q.quoteId)).toEqual(["Q-F588-27-0031"]);
  });

  it("wording", () => {
    expect(addSeatsCount(1)).toBe("1 added seat");
    expect(addSeatsCount(3)).toBe("3 added seats");
  });

  it("addSeats() stores the link and the MRR the seats added", () => {
    const src = readFileSync("src/lib/subscriptions/add-seats.ts", "utf8");
    expect(src).toMatch(/add_seats_subscription_id: input\.subscriptionId/);
    expect(src).toMatch(/add_seats_mrr_added: +priced\.newMrr - input\.currentMrr/);
  });

  it("the drawer, Payments → Subscription dues and the quote page use it", () => {
    const subs = readFileSync("src/app/(app)/subscriptions/page.tsx", "utf8");
    expect(subs).toMatch(/<SeatQuotesPending subscriptionId=\{scheduleSub\.id\} \/>/);
    const pay = readFileSync("src/app/(app)/payments/page.tsx", "utf8");
    expect(pay).toMatch(/useOpenSeatQuotes\(\)/);
    expect(pay).toMatch(/Seat quotes pending · \{rupee\(seatQuotesTotal\)\}/);
    expect(pay).toMatch(/scopedOutstanding\.length > 0 \|\| scopedSeatQuotes\.length > 0/);
    const quote = readFileSync("src/app/(app)/quotes/[id]/page.tsx", "utf8");
    expect(quote).toMatch(/!seatsTakenBack && \(/);
    // R-1634 moved the refresh into invalidateReceivables(), which covers ["subscriptions"].
    expect(quote).toMatch(/if \(quote\?\.is_add_seats\) invalidateReceivables\(qc\)/);
    const refresh = readFileSync("src/lib/queries/receivables-refresh.ts", "utf8");
    expect(refresh).toMatch(/\["subscriptions"\]/);
  });
});
