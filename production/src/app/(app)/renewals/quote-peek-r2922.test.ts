/* R-2922 (18 Nov 2026, Pardeep — staging Q-A378-27-0124: "ye renewal quotation ki tarah jaye"): the quote
   pop-up's line of a month-wise (part) request reads like a renewal quotation's — the product, seats × the
   rate a seat, and the period — never only "Payment for month 1". */
import { describe, it, expect } from "vitest";
import { peekLineDetail, peekLineText, peekLines, peekPeriod, type PeekBilling, type PeekQuoteRow, type PeekSub } from "./quote-peek";

const STARTER = "Google Workspace Business Starter";
const pq = (over: Partial<PeekQuoteRow> = {}): PeekQuoteRow => ({
  id: "PI-A378-27-0008", line_items: [], is_renewal: null, is_extension: null, is_add_seats: null, is_one_off: true, extension_months: null,
  renewal_term_date: null, created_date: "2026-10-30", domain: null, subscription_billing_id: null, renewal_subscription_id: null, ...over,
});
const billing = (id: string, sub: string, start: string, end: string): PeekBilling => ({ id, subscription_id: sub, period_start: start, period_end: end });
const parts = new Map([["B1", billing("B1", "S1", "2026-10-01", "2026-11-01")]]);
const subs = new Map<string, PeekSub>([["S1", { id: "S1", domain: "ravi.in" }]]);

describe("R-2922 — a part request's line in the quote pop-up reads like a renewal quotation's", () => {
  it("a renewal quote line: seats × the rate a seat, then its period", () => {
    const sub: PeekSub = { id: "S1", start_date: "2025-11-01", term_months: 12 };
    const q = pq({ is_one_off: false, is_renewal: true, extension_months: 12, renewal_term_date: "2026-11-01", renewal_subscription_id: "S1",
      line_items: [{ id: "renewal-1", name: STARTER, qty: 2, rate: 1656, cost: 3168, item_id: "GW-STR-a37802c6", commitment: "annual_yearly" }] });
    const [l] = peekLines(q, new Map(), new Map(), sub);
    expect(l.name).toBe(STARTER);
    expect(peekLineDetail(l)).toBe("2 seats × ₹1,656 · 1 Nov 2026–31 Oct 2027");
  });

  it("a new part request line (item_id, cost, per-seat): its name says product, seats and period — the rate a seat is added", () => {
    const named = `${STARTER} · ravi.in · 473 seats · 1 Oct–31 Oct 2026 (part 1 of 12)`;
    const q = pq({ subscription_billing_id: "B1", line_items: [{ id: "part-1", name: named, description: "Payment for month 1 · 1 Oct–31 Oct 2026",
      qty: 473, rate: 135, cost: 110, per_seat: true, one_time: true, item_id: "GW-STR-a37802c6", period_start: "2026-10-01", period_end: "2026-10-31" }] });
    const [l] = peekLines(q, parts, subs);
    expect(l.name).toBe(named);
    expect(l.seatRate).toBe(135);
    expect(peekLineDetail(l)).toBe("₹135 a seat");            // seats, domain and period are in the name — said once
    expect(peekLineText(l)).toBe(named);                       // the hover card's line is unchanged
    expect(peekPeriod([l])).toBe("1 Oct–31 Oct 2026");
  });

  it("a per-seat part line whose name does not say its seats: 'N seats × ₹rate'", () => {
    const q = pq({ subscription_billing_id: "B1", line_items: [{ name: STARTER, qty: 7, rate: 1000, per_seat: true, one_time: true }] });
    const [l] = peekLines(q, parts, subs);
    expect(peekLineDetail(l)).toBe("7 seats × ₹1,000 · ravi.in · 1 Oct–31 Oct 2026");
    /* the pop-up passes the quote's own money words (a foreign-currency quote) */
    expect(peekLineDetail(l, (n) => `$${n / 100}`)).toBe("7 seats × $10 · ravi.in · 1 Oct–31 Oct 2026");
  });

  it("the oldest part request (staging Q-A378-27-0124): the PRODUCT is shown, not 'Payment for month 1'", () => {
    const q = pq({ id: "Q-A378-27-0124", subscription_billing_id: "B1", line_items: [{ id: "part-1", name: "Payment for month 1 · 1 Oct–31 Oct 2026",
      description: `${STARTER} · 473 seats`, qty: 1, rate: 63855, cost: 0, one_time: true }] });
    const [l] = peekLines(q, parts, subs);
    expect(l.name).toBe(`${STARTER} · 473 seats`);
    expect(l.seatRate).toBeNull();                             // a lump line: ₹63,855 is not a rate a seat
    expect(peekLineDetail(l)).toBe("ravi.in · 1 Oct–31 Oct 2026");
    expect(peekLineText(l)).toBe(`${STARTER} · 473 seats · 1 Oct–31 Oct 2026`);
  });

  it("a short label is swapped only on a part request, and only for a real product text", () => {
    /* an ordinary quote whose line happens to be named like a label keeps its name */
    const plain = pq({ line_items: [{ name: "Payment for month 1 · 1 Oct–31 Oct 2026", description: "Something", qty: 1, rate: 100, one_time: true }] });
    expect(peekLines(plain, new Map(), new Map())[0].name).toBe("Payment for month 1 · 1 Oct–31 Oct 2026");
    /* a part line with only its label keeps it (nothing better is known) */
    const bare = pq({ subscription_billing_id: "B1", line_items: [{ name: "Payment for month 1 · 1 Oct–31 Oct 2026", qty: 1, rate: 100, one_time: true }] });
    expect(peekLines(bare, parts, subs)[0].name).toBe("Payment for month 1 · 1 Oct–31 Oct 2026");
  });

  it("no rate a seat is invented: a one-time line, a line with no rate", () => {
    const q = pq({ line_items: [{ name: "Migration", qty: 2, rate: 5000, one_time: true }, { name: STARTER, qty: 3, commitment: "annual_yearly" }] });
    const [a, b] = peekLines(q, new Map(), new Map());
    expect(a.seatRate).toBeNull();
    expect(b.seatRate).toBeNull();
    expect(peekLineDetail(b)).toBe("3 seats · No period on this line");
  });
});

describe("R-2922 — a period written in a line's name is found even when the part's own period was not read", () => {
  it("the R-2423 name carries its day range → the pop-up does not add 'No period on this line' under it", () => {
    const named = `${STARTER} · ravi.in · 473 seats · 1 Oct–31 Oct 2026 (part 1 of 12)`;
    const q = pq({ subscription_billing_id: "B1", line_items: [{ name: named, qty: 473, rate: 135, per_seat: true, one_time: true }] });
    const [l] = peekLines(q, new Map(), new Map());             // the part row is not in the answer
    expect(l.period).toBeNull();
    expect(l.periodInName).toBe(true);
    expect(peekLineDetail(l)).toBe("₹135 a seat");
    /* across a year end, and with a hyphen */
    const y = pq({ subscription_billing_id: "B1", line_items: [{ name: "Plan · 15 Dec 2026-14 Jan 2027 (part 1 of 1)", qty: 1, rate: 10, one_time: true }] });
    expect(peekLines(y, new Map(), new Map())[0].periodInName).toBe(true);
    /* a name with no day range is not taken for one */
    const n = pq({ subscription_billing_id: "B1", line_items: [{ name: "Plan d1 Oct s d2 Nov d2026", qty: 1, rate: 10, one_time: true }] });
    expect(peekLines(n, new Map(), new Map())[0].periodInName).toBe(false);
  });
});
