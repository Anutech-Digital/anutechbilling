/**
 * R-2292 — Manage seats quoted at the app's base rate with no check against what the customer
 * was last invoiced.
 *
 * June reconcile on staging (31 Oct 2026): three add-seats quotes for one customer came out
 * ₹3,147 / ₹2,886 / ₹2,756 where the vendor-of-record billed ₹3,055 / ₹2,803 / ₹2,667 — the
 * subscription's base rate was off, seats went 34 → 37, and nothing warned. These tests pin:
 *   - the expected rate = the last GST invoice line for the subscription's item;
 *   - a warning when the rate used differs from it by more than ₹5/seat/year;
 *   - a rate typed for ONE quote prices that quote only — the subscription's stored rate (its
 *     MRR) moves by the stored rate, and the existing below-cost approval still applies.
 */
import { describe, it, expect } from "vitest";
import {
  expectedSeatRate, seatRateWarning, parseTypedSeatRate, SEAT_RATE_TOLERANCE, seatRateSourceText,
  type RateInvoice,
} from "./seat-rate-check";
import { seatIncreaseQuote } from "./seat-increase-charge";
import { addSeats, type AddSeatsInput } from "./add-seats";
import { staffQuoteNotes } from "@/lib/quotes/customer-notes";

const SUB = { plan: "Google Workspace Business Starter", item_id: "item-starter", domain: "testco.example", quote_id: "Q-SALE", renewal_quote_id: "Q-RENEW" };

const line = (o: Record<string, unknown> = {}) => ({
  id: "l1", item_id: "item-starter", name: "Google Workspace Business Starter", qty: 34, rate: 1440, cost: 1320,
  commitment: "annual_yearly", ...o,
});
const inv = (o: Partial<RateInvoice> = {}): RateInvoice => ({
  id: "INV-1", invoice_date: "2026-04-01", status: "paid", document_kind: "tax_invoice", quote_id: "Q-RENEW",
  line_items: [line()], ...o,
});

describe("expectedSeatRate — the last GST invoice line for the subscription's item", () => {
  it("the newest tax invoice of the subscription's own quotes wins", () => {
    const r = expectedSeatRate(SUB, [
      inv({ id: "INV-OLD", invoice_date: "2025-04-01", quote_id: "Q-SALE", line_items: [line({ rate: 1380 })] }),
      inv({ id: "INV-NEW", invoice_date: "2026-04-01", line_items: [line({ rate: 1440 })] }),
    ]);
    expect(r).toEqual({ annualPerSeat: 1440, invoiceId: "INV-NEW", invoiceDate: "2026-04-01" });
  });

  it("void / draft invoices, opening invoices and pro-rata add-seats lines are not a rate", () => {
    const r = expectedSeatRate(SUB, [
      inv({ id: "INV-VOID", invoice_date: "2026-09-01", status: "void", line_items: [line({ rate: 9999 })] }),
      inv({ id: "INV-DRAFT", invoice_date: "2026-09-02", status: "draft", line_items: [line({ rate: 9999 })] }),
      inv({ id: "OPEN-1", invoice_date: "2026-09-03", document_kind: "opening_invoice", line_items: [line({ rate: 9999 })] }),
      inv({ id: "INV-PRORATA", invoice_date: "2026-09-04", line_items: [line({ rate: 700, name: "Google Workspace Business Starter · +2 seats (pro-rata from 2026-09-04 to 2027-03-31)" })] }),
      inv({ id: "INV-OK", invoice_date: "2026-04-01" }),
    ]);
    expect(r?.invoiceId).toBe("INV-OK");
    expect(r?.annualPerSeat).toBe(1440);
  });

  it("another plan's line is not this item's rate; a name match works when the line has no item id", () => {
    expect(expectedSeatRate(SUB, [inv({ line_items: [line({ item_id: "item-plus", name: "Business Plus", rate: 9000 })] })])).toBeNull();
    const byName = expectedSeatRate(SUB, [inv({ line_items: [line({ item_id: undefined, name: "google workspace  business starter", rate: 1500 })] })]);
    expect(byName?.annualPerSeat).toBe(1500);
  });

  it("a monthly (flex) line is per month — × 12 for the year; a line discount comes off", () => {
    expect(expectedSeatRate(SUB, [inv({ line_items: [line({ commitment: "monthly", rate: 130 })] })])?.annualPerSeat).toBe(1560);
    expect(expectedSeatRate(SUB, [inv({ line_items: [line({ rate: 1500, discount_pct: 10 })] })])?.annualPerSeat).toBe(1350);
  });

  it("the customer's other invoices count only when the subscription's own quotes have none, and only for the same domain", () => {
    const other = inv({ id: "INV-CUST", quote_id: "Q-OTHER", line_items: [line({ rate: 1400, domain: "testco.example" })] });
    const otherDomain = inv({ id: "INV-CUST2", invoice_date: "2026-08-01", quote_id: "Q-OTHER2", line_items: [line({ rate: 1200, domain: "elsewhere.example" })] });
    expect(expectedSeatRate(SUB, [other, otherDomain])?.invoiceId).toBe("INV-CUST");
    expect(expectedSeatRate(SUB, [other, inv({ id: "INV-OWN", invoice_date: "2025-01-01" })])?.invoiceId).toBe("INV-OWN");
  });

  it("no invoice → no expected rate (and no warning)", () => {
    expect(expectedSeatRate(SUB, [])).toBeNull();
    expect(seatRateWarning(1440, null)).toBeNull();
  });
});

describe("seatRateWarning — more than ₹5/seat/year apart", () => {
  const expected = { annualPerSeat: 3055, invoiceId: "INV-9", invoiceDate: "2026-06-01" };
  it("the staging case: ₹3,147 against an invoiced ₹3,055 warns, with both numbers", () => {
    const w = seatRateWarning(3147, expected);
    expect(w).not.toBeNull();
    expect(w!.used).toBe(3147);
    expect(w!.expected).toBe(3055);
    expect(w!.diff).toBe(92);
    expect(w!.message).toContain("₹3,147");
    expect(w!.message).toContain("₹3,055");
    expect(w!.message).toContain("INV-9");
  });
  it("within ₹5 is not a warning; ₹6 is", () => {
    expect(SEAT_RATE_TOLERANCE).toBe(5);
    expect(seatRateWarning(3060, expected)).toBeNull();
    expect(seatRateWarning(3050, expected)).toBeNull();
    expect(seatRateWarning(3061, expected)).not.toBeNull();
    expect(seatRateWarning(3049, expected)!.diff).toBe(-6);
  });
});

describe("parseTypedSeatRate / seatRateSourceText", () => {
  it("blank = no typed rate; a whole positive rupee figure is a rate; anything else is invalid", () => {
    expect(parseTypedSeatRate("")).toEqual({ ok: true, rate: null });
    expect(parseTypedSeatRate("  ")).toEqual({ ok: true, rate: null });
    expect(parseTypedSeatRate("3,055")).toEqual({ ok: true, rate: 3055 });
    expect(parseTypedSeatRate("3055")).toEqual({ ok: true, rate: 3055 });
    expect(parseTypedSeatRate("0").ok).toBe(false);
    expect(parseTypedSeatRate("-5").ok).toBe(false);
    expect(parseTypedSeatRate("30.5").ok).toBe(false);
    expect(parseTypedSeatRate("abc").ok).toBe(false);
    expect(parseTypedSeatRate("100000000").ok).toBe(false);
  });
  it("says where the rate came from", () => {
    expect(seatRateSourceText({ typed: null, storedAnnualPerSeat: 3147, currentMrr: 8917, currentSeats: 34 }))
      .toBe("From this subscription (₹8,917/mo ÷ 34 seats × 12)");
    expect(seatRateSourceText({ typed: 3055, storedAnnualPerSeat: 3147, currentMrr: 8917, currentSeats: 34 }))
      .toBe("Typed for this quote only (subscription rate ₹3,147 stays)");
  });
});

describe("seatIncreaseQuote — a typed rate prices the quote, not the subscription", () => {
  const base = { currentSeats: 34, currentMrr: 8917, additionalSeats: 1, taxRatePct: 18, current: { remainingDays: 365, termDays: 365 } };
  it("no typed rate: unchanged (rate from MRR)", () => {
    const q = seatIncreaseQuote(base);
    expect(q.annualPerSeat).toBe(3147);
    expect(q.current.perSeat).toBe(3147);
  });
  it("typed ₹3,055: the line is ₹3,055 for a full year; new MRR still grows at the stored rate", () => {
    const stored = seatIncreaseQuote(base);
    const q = seatIncreaseQuote({ ...base, annualPerSeatOverride: 3055 });
    expect(q.annualPerSeat).toBe(3055);
    expect(q.current.perSeat).toBe(3055);
    expect(q.subtotal).toBe(3055);
    expect(q.newMrr).toBe(stored.newMrr);
  });
  it("pro-rata maths unchanged: 182 of 365 days at ₹3,055", () => {
    const q = seatIncreaseQuote({ ...base, additionalSeats: 3, annualPerSeatOverride: 3055, current: { remainingDays: 182, termDays: 365 } });
    expect(q.current.perSeat).toBe(Math.round((3055 * 182) / 365));
    expect(q.subtotal).toBe(q.current.perSeat * 3);
  });
});

/* ── addSeats with a typed rate — the quote written, the subscription left at its rate ── */
function fakeSupabase(writes: { quotes: Record<string, unknown>[]; subs: Record<string, unknown>[] }, catalogCostPm = 110) {
  const table = (name: string) => ({
    select: () => ({ eq: () => Promise.resolve({
      data: name === "items" ? [{ id: "item-starter", name: "Google Workspace Business Starter", vendor: "google", prices: null, wholesale: catalogCostPm }] : [],
      error: null,
    }) }),
    insert: (row: Record<string, unknown>) => {
      if (name === "quotes") writes.quotes.push(row);
      return Promise.resolve({ error: null });
    },
    update: (row: Record<string, unknown>) => {
      if (name === "subscriptions") writes.subs.push(row);
      return { eq: () => Promise.resolve({ error: null }) };
    },
  });
  return {
    from: (name: string) => table(name),
    rpc: () => Promise.resolve({ data: "Q-TEST-0001", error: null }),
  } as unknown as AddSeatsInput["supabase"];
}

async function run(over: Partial<AddSeatsInput> = {}, costPm = 110) {
  const writes = { quotes: [] as Record<string, unknown>[], subs: [] as Record<string, unknown>[] };
  const r = await addSeats({
    supabase: fakeSupabase(writes, costPm),
    subscriptionId: "sub-1", tenantId: "t-1", customerId: "c-1", customerName: "E2E Test Co",
    plan: "Google Workspace Business Starter", vendor: "google", itemId: "item-starter", domain: "testco.example",
    currentSeats: 34, currentMrr: 8917, additionalSeats: 1,
    renewalDate: "2027-10-31", termEnd: "2027-11-01", graceDays: 7, taxRatePct: 18, termDays: 365,
    todayISO: "2026-11-01", requestedBy: "U1",
    ...over,
  });
  expect(r.ok).toBe(true);
  return { r, quote: writes.quotes[0], sub: writes.subs[0] };
}

describe("addSeats — R-2292 typed rate", () => {
  it("without a typed rate the quote is exactly as before (no list_rate, rate from MRR)", async () => {
    const { quote } = await run();
    const l = (quote.line_items as Array<Record<string, unknown>>)[0];
    expect(l.rate).toBe(3147);
    expect("list_rate" in l).toBe(false);
  });

  it("typed ₹3,055: the line is ₹3,055, the subscription's rate stays (MRR grows by the stored rate), notes say so", async () => {
    const plain = await run();
    const { quote, sub } = await run({ annualPerSeatOverride: 3055 });
    const l = (quote.line_items as Array<Record<string, unknown>>)[0];
    expect(l.rate).toBe(3055);
    /* The stored rate is the line's list price, so a lower typed rate is a discount the existing
       approval rule sees (R-2213 serverApprovalColumns), never hidden. */
    expect(l.list_rate).toBe(3147);
    expect(quote.subtotal).toBe(3055);
    expect(sub.mrr).toBe(plain.sub.mrr);
    expect(quote.add_seats_mrr_added).toBe(plain.quote.add_seats_mrr_added);
    expect(staffQuoteNotes(String(quote.notes))).toContain("Rate ₹3,055/seat/yr typed for this quote (subscription rate ₹3,147/seat/yr unchanged)");
  });

  it("a typed rate below cost still goes to the owner — the R-2213 below-cost rule is not bypassed", async () => {
    const { quote } = await run({ annualPerSeatOverride: 1000 }, 110 /* ₹1,320/yr cost */);
    expect(quote.below_cost).toBe(true);
    expect(quote.approval_status).toBe("pending");
    expect(quote.approval_tier).toBe("owner");
  });

  it("an invalid typed rate is refused before anything is written", async () => {
    const writes = { quotes: [] as Record<string, unknown>[], subs: [] as Record<string, unknown>[] };
    const r = await addSeats({
      supabase: fakeSupabase(writes), subscriptionId: "sub-1", tenantId: "t-1", customerId: null, customerName: "E2E Test Co",
      plan: "Google Workspace Business Starter", vendor: "google", domain: null, currentSeats: 34, currentMrr: 8917,
      additionalSeats: 1, renewalDate: "2027-10-31", graceDays: 7, taxRatePct: 18, termDays: 365, todayISO: "2026-11-01",
      annualPerSeatOverride: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_rate");
    expect(writes.quotes).toHaveLength(0);
    expect(writes.subs).toHaveLength(0);
  });
});
