/**
 * R-2658 — a foreign inward remittance ("INW … USD1024.0@93.6") is paired with its Zoho payment by
 * the FOREIGN amount: same currency, within 1 unit, dated within 10 days of the bank line. A pair is
 * "sure" (by "fx_amount") only when that payment is the ONLY candidate and no other open bank line
 * could be the same payment. Zoho is never called; values are made up.
 */
import { describe, it, expect } from "vitest";
import { findInPaymentList, lineHasZohoMatch, paymentWindow, type BatchLine } from "./payment-batch";
import { FX_AMOUNT_TOLERANCE, FX_DATE_WINDOW_DAYS, lineRemittance, type ZohoPaymentRow } from "./payment-match";

const pay = (o: Partial<ZohoPaymentRow>): ZohoPaymentRow => ({
  zohoId: "p", number: "9001", date: "2026-08-07", amount: 1024, reference: "", customerZohoId: "zc", customerName: "Design Box",
  currency: "USD", exchangeRate: 93.1, ...o,
});
const inw = (o: Partial<BatchLine> = {}): BatchLine => ({
  id: "l1", txnDate: "2026-08-07", credit: 95846, description: "INW 070826I049902623 USD1024.0@93.6", reference: "0000070826114968", ...o,
});

describe("R-2658 pairing a USD inward line with its Zoho payment", () => {
  it("the card's figures: ±1 unit, ±10 days", () => {
    expect(FX_AMOUNT_TOLERANCE).toBe(1);
    expect(FX_DATE_WINDOW_DAYS).toBe(10);
  });

  it("one USD payment of the same amount, 6 days before the bank date → one, by fx_amount", () => {
    const found = findInPaymentList(inw(), [pay({ date: "2026-08-01" }), pay({ zohoId: "other", amount: 500 })]);
    expect(found).toMatchObject({ kind: "one", by: "fx_amount", payment: { zohoId: "p" } });
  });

  it("two candidates: two USD payments of that amount inside the window → several, never one", () => {
    const found = findInPaymentList(inw(), [pay({ zohoId: "a", date: "2026-08-01" }), pay({ zohoId: "b", date: "2026-08-12" })]);
    expect(found.kind).toBe("several");
    if (found.kind === "several") expect(found.candidates.map((c) => c.zohoId).sort()).toEqual(["a", "b"]);
  });

  it("tolerance and window: 1 unit off pairs, 2 off does not; 10 days pairs, 11 does not", () => {
    expect(findInPaymentList(inw(), [pay({ amount: 1024.5 })])).toMatchObject({ kind: "one", by: "fx_amount" });
    expect(findInPaymentList(inw(), [pay({ amount: 1025 })])).toMatchObject({ kind: "one", by: "fx_amount" });
    /* 2 units off, same day: the old "amount + date" rule still finds it — never a sure pair. */
    expect(findInPaymentList(inw(), [pay({ amount: 1026 })])).toMatchObject({ kind: "one", by: "amount_date" });
    expect(findInPaymentList(inw(), [pay({ amount: 1026, date: "2026-08-01" })])).toEqual({ kind: "none" });
    expect(findInPaymentList(inw(), [pay({ date: "2026-08-17" })])).toMatchObject({ kind: "one", by: "fx_amount" });
    expect(findInPaymentList(inw(), [pay({ date: "2026-07-28" })])).toMatchObject({ kind: "one", by: "fx_amount" });
    expect(findInPaymentList(inw(), [pay({ date: "2026-08-18" })])).toEqual({ kind: "none" });
    expect(findInPaymentList(inw(), [pay({ date: "2026-07-27" })])).toEqual({ kind: "none" });
    expect(findInPaymentList(inw(), [pay({ date: null })])).toEqual({ kind: "none" });
  });

  it("another currency of the same figure is not this money", () => {
    expect(findInPaymentList(inw(), [pay({ currency: "EUR" })])).toEqual({ kind: "none" });
    const eur = inw({ credit: 9785, description: "INW 060625I049903969 EUR102.21@95.73", txnDate: "2025-06-09" });
    expect(findInPaymentList(eur, [pay({ currency: "EUR", amount: 102.21, date: "2025-06-03" })])).toMatchObject({ kind: "one", by: "fx_amount" });
  });

  it("rival line: two open bank lines of the same USD amount that could both be the one Zoho payment → matched, but not sure", () => {
    const a = inw({ id: "a", txnDate: "2026-08-05", credit: 86330, description: "INW 010825I049902312 USD1000.0@86.33" });
    const b = inw({ id: "b", txnDate: "2026-08-12", credit: 86620, description: "INW 050925I049903238 USD1000.0@86.62" });
    const far = inw({ id: "c", txnDate: "2026-09-08", credit: 86620, description: "INW 050925I049903238 USD1000.0@86.62" });
    const p = [pay({ amount: 1000, date: "2026-08-08" })];
    expect(findInPaymentList(a, p, [a, b, far])).toMatchObject({ kind: "one", by: "fx_amount", notSure: expect.stringContaining("Another bank line (2026-08-12") });
    expect(findInPaymentList(b, p, [a, b, far])).toMatchObject({ kind: "one", by: "fx_amount", notSure: expect.stringContaining("Another bank line") });
    /* A line of that amount a month away cannot be this payment — no rival. */
    const alone = findInPaymentList(a, p, [a, far]);
    expect(alone).toMatchObject({ kind: "one", by: "fx_amount" });
    expect(alone.kind === "one" && alone.notSure).toBeUndefined();
    /* The line itself in the list is not its own rival. */
    const self = findInPaymentList(a, p, [a]);
    expect(self.kind === "one" && self.notSure).toBeUndefined();
    /* A RECONCILED line of that amount (it may already have used this payment) is a rival too — the caller passes it. */
    const reconciled = inw({ id: "done", txnDate: "2026-08-02", credit: 86330, description: "INW 010825I049902312 USD1000.0@86.33" });
    expect(findInPaymentList(a, p, [a, reconciled])).toMatchObject({ kind: "one", by: "fx_amount", notSure: expect.stringContaining("Another bank line") });
    /* A payment list that was cut short: paired, never sure. */
    expect(findInPaymentList(a, p, [a], false)).toMatchObject({ kind: "one", by: "fx_amount", notSure: expect.stringContaining("more payments in this period") });
  });

  it("narration that does not fit the credit: never paired by the foreign amount", () => {
    const odd = inw({ credit: 90000 });
    expect(lineRemittance(odd)).toBeNull();
    /* 6 days away → outside the ₹ rule's 3 days, and the 10-day rule does not apply. */
    expect(findInPaymentList(odd, [pay({ date: "2026-08-01" })])).toEqual({ kind: "none" });
    /* Same day: the old rule (R-2425) still finds it, as "amount + date" — a person looks. */
    expect(findInPaymentList(odd, [pay({})])).toMatchObject({ kind: "one", by: "amount_date" });
  });

  it("rupee lines unchanged: a ₹ line keeps ±₹2 / ±3 days; a ₹ or currency-less Zoho payment is never fx_amount", () => {
    const rupee = inw({ credit: 11800, description: "NEFT CR-HDFC0000240-KAPOOR LEGAL-OUR COMPANY LLP" , reference: null });
    expect(findInPaymentList(rupee, [pay({ currency: "INR", amount: 11801, date: "2026-08-10" })])).toMatchObject({ kind: "one", by: "amount_date" });
    expect(findInPaymentList(rupee, [pay({ currency: "INR", amount: 11800, date: "2026-08-12" })])).toEqual({ kind: "none" });
    /* An INW line whose Zoho payment is in ₹ (customer billed in rupees): the ₹ rule only. */
    expect(findInPaymentList(inw(), [pay({ currency: "INR", amount: 95846, date: "2026-08-09" })])).toMatchObject({ kind: "one", by: "amount_date" });
    expect(findInPaymentList(inw(), [pay({ currency: "INR", amount: 95846, date: "2026-08-14" })])).toEqual({ kind: "none" });
    /* Zoho gave no currency: the foreign amount may fit, but only by the old 3-day rule and never sure. */
    expect(findInPaymentList(inw(), [pay({ currency: undefined, date: "2026-08-09" })])).toMatchObject({ kind: "one", by: "amount_date" });
    expect(findInPaymentList(inw(), [pay({ currency: undefined, date: "2026-08-14" })])).toEqual({ kind: "none" });
  });

  it("a ₹ candidate and a USD candidate together → several", () => {
    const found = findInPaymentList(inw(), [pay({ zohoId: "usd", date: "2026-08-01" }), pay({ zohoId: "inr", currency: "INR", amount: 95846 })]);
    expect(found.kind).toBe("several");
  });

  it("UTR first: the line's reference in Zoho's payment reference still wins", () => {
    const found = findInPaymentList(inw(), [
      pay({ zohoId: "by-ref", amount: 7, currency: "INR", date: "2026-01-01", reference: "070826114968" }),
      pay({ zohoId: "by-usd", date: "2026-08-01" }),
    ]);
    expect(found).toMatchObject({ kind: "one", by: "utr", payment: { zohoId: "by-ref" } });
  });

  it("window: ±10 days round an inward-remittance line, ±3 round a ₹ line", () => {
    expect(paymentWindow([{ txnDate: "2026-07-21" }, { txnDate: "2026-04-02" }])).toEqual({ from: "2026-03-30", to: "2026-07-24" });
    expect(paymentWindow([inw({ txnDate: "2026-04-02" }), { txnDate: "2026-07-21" }])).toEqual({ from: "2026-03-23", to: "2026-07-24" });
    expect(paymentWindow([inw({ txnDate: "2026-08-07" })])).toEqual({ from: "2026-07-28", to: "2026-08-17" });
  });

  it("Zoho has a match: counts a USD payment 6 days away for an inward line", () => {
    expect(lineHasZohoMatch(inw(), [pay({ date: "2026-08-01" })])).toBe(true);
    expect(lineHasZohoMatch(inw(), [pay({ date: "2026-07-20" })])).toBe(false);
  });
});
