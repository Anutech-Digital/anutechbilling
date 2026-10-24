/**
 * R-1683 (staging 19 Oct, T-12 / T-15): the billing schedule must list EVERY invoice raised for
 * the subscription's term — the add-seats invoice and the renewal invoice too — and its amounts
 * must be what those invoices say, so nobody reads a billed term as "not billed yet".
 */
import { describe, it, expect } from "vitest";
import { scheduleInvoices, nextUninvoiced, termAddSeatInvoices, shownTermTotal, scheduleCountLabel } from "./schedule-invoices";
import { subscriptionSchedule } from "@/lib/billing/subscription-schedule";
import type { Subscription } from "@/lib/supabase/database.types";
import { scheduleQuotesOr } from "@/lib/queries/subscriptions";

const sub = (over: Partial<Subscription> = {}) => ({
  mrr: 16_200, billing_cycle: "yearly" as const, term_months: 12,
  start_date: "2026-10-01", renewal_date: "2027-09-30", ...over,
}) as Subscription;

describe("T-12: a 10-seat annual term + 5 seats added mid-term", () => {
  const periods = subscriptionSchedule(sub());
  const invoiced = scheduleInvoices({
    periods, startDate: "2026-10-01",
    saleInvoice: { invoiceId: "INV-0073", status: "paid", exGst: 129_600 },
    instalments: [],
  });
  const addSeats = [
    { invoiceId: "INV-0074", status: "paid", invoiceDate: "2026-12-10", exGst: 43_140 },
    { invoiceId: "INV-OLD",  status: "paid", invoiceDate: "2025-12-10", exGst: 9_999 },   // a previous term
    { invoiceId: "INV-VOID", status: "void", invoiceDate: "2026-12-11", exGst: 1_000 },   // cancelled
  ];

  it("the add-seats invoice is listed under this term (and only this term's, not void)", () => {
    expect(termAddSeatInvoices(periods, addSeats).map((i) => i.invoiceId)).toEqual(["INV-0074"]);
  });

  it("the term total is the invoices' own figures — ₹1,29,600 + ₹43,140, not mrr × 12 = ₹1,94,400", () => {
    expect(shownTermTotal(periods, invoiced, termAddSeatInvoices(periods, addSeats))).toBe(172_740);
  });

  it("the header names the added-seats invoice", () => {
    expect(scheduleCountLabel(1, 1, 1)).toBe("1 billing date · 1 invoiced · 1 added-seats invoice");
    expect(scheduleCountLabel(4, 0)).toBe("4 billing dates");
  });
});

describe("T-15: a renewal paid for the new term marks that term billed", () => {
  /* Renewal quote made for renewal_date 31 Oct 2026; paid → renewal_date rolled to 31 Oct 2027,
     so the current term starts 1 Nov 2026. */
  const renewed = sub({ start_date: "2025-11-01", renewal_date: "2027-10-31" });
  const periods = subscriptionSchedule(renewed);

  it("the renewal invoice is on the 'This term' row and nothing is 'next'", () => {
    const m = scheduleInvoices({
      periods, startDate: "2025-11-01", saleInvoice: null, instalments: [],
      renewals: [{ invoiceId: "INV-0077", status: "paid", termDate: "2026-10-31", exGst: 194_400 }],
    });
    expect(m.get(periods[0].index)).toMatchObject({ invoiceId: "INV-0077", status: "paid" });
    expect(nextUninvoiced(periods, m, "2026-11-01")).toBeNull();
  });

  it("an anniversary-shaped renewal (term date = first day of the new term) matches too", () => {
    const m = scheduleInvoices({
      periods, startDate: "2025-11-01", saleInvoice: null, instalments: [],
      renewals: [{ invoiceId: "INV-0077", status: "paid", termDate: "2026-11-01", exGst: 194_400 }],
    });
    expect(m.size).toBe(1);
  });

  it("the PREVIOUS term's renewal invoice does not mark this term", () => {
    const m = scheduleInvoices({
      periods, startDate: "2025-11-01", saleInvoice: null, instalments: [],
      renewals: [
        { invoiceId: "INV-PREV", status: "paid", termDate: "2025-10-31", exGst: 1 },
        { invoiceId: "INV-VOID", status: "void", termDate: "2026-10-31", exGst: 1 },
      ],
    });
    expect(m.size).toBe(0);
    expect(nextUninvoiced(periods, m, "2026-11-01")).toBe(periods[0].index);
  });
});

describe("R-1683: the schedule reads every quote that billed the subscription", () => {
  it("sale quote (quoted id), renewal quotes and add-seats quotes", () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(scheduleQuotesOr({ id, quote_id: "Q-5F40-27-0073" })).toBe(
      `id.eq."Q-5F40-27-0073",renewal_subscription_id.eq.${id},add_seats_subscription_id.eq.${id}`,
    );
    expect(scheduleQuotesOr({ id, quote_id: null })).toBe(
      `renewal_subscription_id.eq.${id},add_seats_subscription_id.eq.${id}`,
    );
    expect(scheduleQuotesOr({ id: "not-a-uuid,x", quote_id: 'Q"1' })).toBe(`id.eq."Q1"`);
  });
});
