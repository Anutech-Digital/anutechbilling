/**
 * R-2870 — after a "together" renewal quote (one quote, 2+ yearly subscriptions, R-2847/R-2848/R-2849) is paid in full,
 * the renewed rows said "No payment yet" and were missing from "Renewed this month": the readers found quotes by
 * quotes.renewal_subscription_id / renewal_term_date, which a together quote leaves empty (its members sit in
 * renewal_quote_subscriptions, and paying clears subscriptions.renewal_quote_id).
 */
import { describe, it, expect } from "vitest";
import { lastDocsBySubscription, type DocInvoice, type DocQuote, type TogetherLink } from "./last-docs";
import { lastPaidBySubscription, linkedDocs, type LastPaidInput } from "./last-paid";
import { monthOf, paidRenewalsInMonth, renewalTiles, togetherMemberPayments } from "./tiles";

const A = "s-a";
const B = "s-b";
const link = (over: Partial<TogetherLink> & { subscription_id: string }): TogetherLink => ({
  quote_id: "QT-1", renewal_term_date: "2026-11-20", subtotal: 20000, renewed_at: "2026-11-16T10:00:00Z", released_at: null, ...over,
});
const quote = (over: Partial<DocQuote> = {}): DocQuote => ({
  id: "QT-1", status: "accepted", payment_status: "invoiced", created_at: "2026-11-10T05:00:00Z", created_date: "2026-11-10",
  expires_date: null, invoice_id: "INV-T", renewal_subscription_id: null, add_seats_subscription_id: null,
  subscription_billing_id: null, superseded_by: null, amount: 44746, ...over,
});
const invoice: DocInvoice = {
  id: "INV-T", quote_id: "QT-1", invoice_date: "2026-11-16", status: "paid", amount: 44746, paid_amount: 44746,
  currency: "INR", created_at: "2026-11-16T10:00:00Z",
};
/* a paid together quote: the subscriptions' renewal_quote_id is cleared (R-2848) */
const subs = [A, B].map((id) => ({ id, quote_id: null, renewal_quote_id: null, start_date: "2025-11-20" }));

describe("R-2870 Last bill of a renewed together member", () => {
  it("each member row shows the together invoice (paid) once the quote is paid in full", () => {
    const links = [link({ subscription_id: A }), link({ subscription_id: B })];
    const out = lastDocsBySubscription({ subs, quotes: [quote()], billings: [], invoices: [invoice], links });
    for (const id of [A, B]) {
      expect(out.get(id)!.invoice?.id).toBe("INV-T");
      expect(out.get(id)!.quote?.id).toBe("QT-1");
    }
  });
  it("without the link rows the rows have nothing (the bug)", () => {
    const out = lastDocsBySubscription({ subs, quotes: [quote()], billings: [], invoices: [invoice] });
    expect(out.get(A)!.invoice).toBeNull();
  });
  it("a released link (quote closed with no money) attaches nothing", () => {
    const links = [link({ subscription_id: A, released_at: "2026-11-12T00:00:00Z", renewed_at: null })];
    const out = lastDocsBySubscription({ subs, quotes: [quote()], billings: [], invoices: [invoice], links });
    expect(out.get(A)!.invoice).toBeNull();
  });
  it("a link for a subscription that is not listed is ignored", () => {
    const out = lastDocsBySubscription({ subs: [subs[0]], quotes: [quote()], billings: [], invoices: [invoice], links: [link({ subscription_id: B })] });
    expect(out.get(A)!.invoice).toBeNull();
    expect(out.has(B)).toBe(false);
  });
});

describe("R-2870 Last paid of a renewed together member", () => {
  const pay = { id: "p1", amount: 44746, method: "upi", status: "received", received_at: "2026-11-16T10:00:00Z", refunded_at: null, quote_id: "QT-1", invoice_id: null };
  const input = (links: TogetherLink[]): LastPaidInput => ({
    subs, linkedQuotes: [{ id: "QT-1", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: "INV-T" }],
    billings: [], invoices: [{ id: "INV-T", quote_id: "QT-1" }], payments: [pay], links,
  });
  const links = [link({ subscription_id: A }), link({ subscription_id: B })];
  it("both rows get the payment, naming the invoice and counting 2 subscriptions", () => {
    const m = lastPaidBySubscription(input(links));
    for (const id of [A, B]) {
      expect(m.get(id)!.last.paymentId).toBe("p1");
      expect(m.get(id)!.last.invoiceId).toBe("INV-T");
      expect(m.get(id)!.last.covers).toBe(2);
    }
  });
  it("no links: no payment on the rows (as before)", () => {
    expect(lastPaidBySubscription(input([])).has(A)).toBe(false);
  });
  it("linkedDocs reaches the together quote's invoice for the member", () => {
    expect([...linkedDocs(input(links)).invoiceSubs.get("INV-T") ?? []].sort()).toEqual([A, B]);
  });
});

describe("R-2870 Renewed this month counts each together member once, at its own share", () => {
  const month = monthOf("2026-11-16");
  const paidQuote = { id: "QT-1", amount: 44746, payment_amount: 44746, payment_status: "invoiced", status: "accepted", tax_rate: 18, discount_pct: 0 };
  const links = [link({ subscription_id: A, subtotal: 20000 }), link({ subscription_id: B, subtotal: 17925 })];
  it("one tile entry per member, with its own subtotal before GST (never the whole quote on each)", () => {
    const rows = togetherMemberPayments(links, [paidQuote], month);
    expect(rows.map((r) => r.renewal_subscription_id).sort()).toEqual([A, B]);
    const t = renewalTiles([], rows, month).renewedMonth;
    expect(t.count).toBe(2);
    expect(t.amount).toBe(20000 + 17925);
  });
  it("paidRenewalsInMonth keeps both members (their ids differ)", () => {
    expect(paidRenewalsInMonth(togetherMemberPayments(links, [paidQuote], month), month)).toHaveLength(2);
  });
  it("part-paid, cancelled or rejected quote counts nothing", () => {
    expect(renewalTiles([], togetherMemberPayments(links, [{ ...paidQuote, payment_amount: 1000 }], month), month).renewedMonth.count).toBe(0);
    expect(renewalTiles([], togetherMemberPayments(links, [{ ...paidQuote, status: "cancelled" }], month), month).renewedMonth.count).toBe(0);
  });
  it("a member whose term is in another month, or a released link, is not in this month", () => {
    const other = [link({ subscription_id: A, renewal_term_date: "2026-12-05" }), link({ subscription_id: B, released_at: "2026-11-01T00:00:00Z" })];
    expect(renewalTiles([], togetherMemberPayments(other, [paidQuote], month), month).renewedMonth.count).toBe(0);
  });
  it("a link whose quote was not read adds nothing", () => {
    expect(togetherMemberPayments(links, [], month)).toEqual([]);
  });
});
