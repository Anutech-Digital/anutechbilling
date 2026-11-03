/* R-2422 — Pardeep, 3 Nov: "last time kitna diya, kab" at renewal time without opening other pages.
   The Renewals row shows the latest captured payment linked to THAT subscription (its original
   quote, its renewal quotes, its add-seats quotes, its instalment invoices); refunds excluded. */
import { describe, expect, it } from "vitest";
import { lastPaidBySubscription, lastPaidSummary, NEVER_PAID, type LastPaidInput } from "./last-paid";

function input(over: Partial<LastPaidInput> = {}): LastPaidInput {
  return {
    subs: [
      { id: "s1", quote_id: "Q-1", renewal_quote_id: "Q-9" },
      { id: "s2", quote_id: "Q-2", renewal_quote_id: null },
    ],
    linkedQuotes: [
      { id: "Q-5", renewal_subscription_id: "s1", add_seats_subscription_id: null, invoice_id: null },
      { id: "Q-6", renewal_subscription_id: null, add_seats_subscription_id: "s1", invoice_id: "INV-OLD" },
    ],
    billings: [{ subscription_id: "s1", invoice_id: "INV-7" }],
    invoices: [
      { id: "INV-1", quote_id: "Q-1" },
      { id: "INV-5", quote_id: "Q-5" },
    ],
    payments: [],
    ...over,
  };
}

const pay = (p: Partial<LastPaidInput["payments"][number]> & { id: string; received_at: string }) => ({
  amount: 1000, method: "upi", status: "received", refunded_at: null, quote_id: null, invoice_id: null, ...p,
});

describe("R-2422 lastPaidBySubscription", () => {
  it("picks the LATEST received payment across the original quote, a renewal quote and an instalment invoice", () => {
    const m = lastPaidBySubscription(input({
      payments: [
        pay({ id: "p1", quote_id: "Q-1", received_at: "2025-11-12T05:00:00Z", amount: 78000 }),
        pay({ id: "p2", quote_id: "Q-5", received_at: "2026-02-03T05:00:00Z", amount: 19500, method: "bank_transfer" }),
        pay({ id: "p3", invoice_id: "INV-7", received_at: "2026-01-04T05:00:00Z", amount: 19500 }),
      ],
    }));
    const s1 = m.get("s1")!;
    expect(s1.last.paymentId).toBe("p2");
    /* Paid against the quote; the invoice raised from that quote is what the row names. */
    expect(s1.last.invoiceId).toBe("INV-5");
    expect(s1.last.amount).toBe(19500);
    expect(s1.history.map((h) => h.paymentId)).toEqual(["p2", "p3", "p1"]);
  });

  it("refunds are excluded — a refunded later payment never becomes 'last paid'", () => {
    const m = lastPaidBySubscription(input({
      payments: [
        pay({ id: "old", quote_id: "Q-1", received_at: "2025-11-12T05:00:00Z" }),
        pay({ id: "ref", quote_id: "Q-9", received_at: "2026-10-30T05:00:00Z", status: "refunded", refunded_at: "2026-10-31T05:00:00Z" }),
        pay({ id: "half", quote_id: "Q-9", received_at: "2026-10-29T05:00:00Z", refunded_at: "2026-10-30T05:00:00Z" }),
      ],
    }));
    expect(m.get("s1")!.last.paymentId).toBe("old");
  });

  it("another subscription's payment never shows on this row", () => {
    const m = lastPaidBySubscription(input({
      payments: [pay({ id: "p-s2", quote_id: "Q-2", received_at: "2026-10-01T05:00:00Z" })],
    }));
    expect(m.get("s1")).toBeUndefined();
    expect(m.get("s2")!.last.paymentId).toBe("p-s2");
    /* No invoice raised from Q-2 yet → the quote is named instead. */
    expect(m.get("s2")!.last.invoiceId).toBeNull();
    expect(m.get("s2")!.last.quoteId).toBe("Q-2");
  });

  it("an add-seats quote whose invoice is linked only on the quote side still counts", () => {
    const m = lastPaidBySubscription(input({
      payments: [pay({ id: "p-old", invoice_id: "INV-OLD", received_at: "2026-03-01T05:00:00Z" })],
    }));
    expect(m.get("s1")!.last.invoiceId).toBe("INV-OLD");
  });

  it("history keeps the last 3, newest first; same time → higher id first (stable)", () => {
    const m = lastPaidBySubscription(input({
      payments: ["a", "b", "c", "d"].map((id, i) => pay({ id, quote_id: "Q-1", received_at: `2026-0${i + 1}-01T05:00:00Z` })),
    }));
    expect(m.get("s1")!.history.map((h) => h.paymentId)).toEqual(["d", "c", "b"]);
  });
});

describe("R-2422 lastPaidSummary — the row's words", () => {
  it("invoice · date · ₹ amount · method", () => {
    const s = lastPaidSummary({ paymentId: "p", amount: 78000.4, method: "bank_transfer", receivedAt: "2026-02-03T05:00:00Z", invoiceId: "INV-5", quoteId: "Q-5" });
    expect(s.doc).toBe("INV-5");
    expect(s.amount).toBe("₹78,000");
    expect(s.method).toBe("Bank transfer");
    expect(s.date).toMatch(/3 Feb 2026|03 Feb 2026|Feb 3, 2026/);
  });

  it("nothing paid → '— never paid in the app'", () => {
    expect(NEVER_PAID).toBe("— never paid in the app");
  });
});
