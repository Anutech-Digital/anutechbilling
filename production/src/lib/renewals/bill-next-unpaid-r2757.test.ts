/**
 * R-2757 (user audit 14 Nov) — Greentin Check 2095: the Oct part Q-F588-27-0059 was sent and unpaid
 * ("Part bill overdue 44d") while Bill next part offered 1–30 Nov ₹3,835 with no word about October.
 * The preview now lists earlier parts still unpaid (same "with the customer, unpaid" rule as the row).
 */
import { describe, it, expect } from "vitest";
import { billMonthsWord, earlierUnpaidParts, periodsToBillLabel, type EarlierPartQuote, type EarlierPartRow } from "@/lib/billing/proforma";

const TODAY = "2026-11-14";
const row = (over: Partial<EarlierPartRow> & { id: string; period_start: string; period_end: string }): EarlierPartRow =>
  ({ invoice_id: null, due_on: null, ...over });
const quote = (over: Partial<EarlierPartQuote> & { id: string; subscription_billing_id: string }): EarlierPartQuote =>
  ({ status: "sent", amount: 3835, payment_amount: 0, payment_status: "none", superseded_by: null, ...over });

const SEP = row({ id: "b-sep", period_start: "2026-09-01", period_end: "2026-10-01", invoice_id: "INV-9" });
const OCT = row({ id: "b-oct", period_start: "2026-10-01", period_end: "2026-11-01", due_on: "2026-10-01" });

describe("R-2757 earlierUnpaidParts", () => {
  it("Greentin: the Oct proforma sent and unpaid is named — period, number, ₹ due, days overdue", () => {
    const r = earlierUnpaidParts({
      rows: [SEP, OCT], quotes: [quote({ id: "Q-F588-27-0059", subscription_billing_id: "b-oct" })],
      invoices: [{ id: "INV-9", status: "paid", amount: 3835, paid_amount: 3835 }], firstStart: "2026-11-01", todayISO: TODAY,
    });
    expect(r).toEqual([{ kind: "proforma", id: "Q-F588-27-0059", start: "2026-10-01", end: "2026-10-31", due: 3835, dueDate: "2026-10-01", daysOverdue: 44 }]);
  });

  it("nothing unpaid (paid, received, cancelled, draft, revised away) → []", () => {
    for (const q of [
      quote({ id: "Q1", subscription_billing_id: "b-oct", payment_status: "received" }),
      quote({ id: "Q2", subscription_billing_id: "b-oct", status: "cancelled" }),
      quote({ id: "Q3", subscription_billing_id: "b-oct", status: "draft" }),
      quote({ id: "Q4", subscription_billing_id: "b-oct", superseded_by: "Q4-R2" }),
      quote({ id: "Q5", subscription_billing_id: "b-oct", amount: 3835, payment_amount: 3835, payment_status: "partial" }),
    ]) {
      expect(earlierUnpaidParts({ rows: [OCT], quotes: [q], invoices: [], firstStart: "2026-11-01", todayISO: TODAY })).toEqual([]);
    }
  });

  it("part paid → only what is left; not yet due → 0 days overdue", () => {
    const r = earlierUnpaidParts({
      rows: [row({ id: "b-oct", period_start: "2026-10-01", period_end: "2026-11-01", due_on: "2026-11-20" })],
      quotes: [quote({ id: "PI-1", subscription_billing_id: "b-oct", payment_amount: 1000, payment_status: "partial" })],
      invoices: [], firstStart: "2026-11-01", todayISO: TODAY,
    });
    expect(r[0]).toMatchObject({ id: "PI-1", due: 2835, dueDate: "2026-11-20", daysOverdue: 0 });
  });

  it("an earlier invoiced part with money still due is named as the invoice (its proforma no longer asks)", () => {
    const r = earlierUnpaidParts({
      rows: [SEP], quotes: [quote({ id: "PI-SEP", subscription_billing_id: "b-sep", status: "accepted" })],
      invoices: [{ id: "INV-9", status: "sent", amount: 3835, paid_amount: 835, due_date: "2026-09-10" }],
      firstStart: "2026-11-01", todayISO: TODAY,
    });
    expect(r).toEqual([{ kind: "invoice", id: "INV-9", start: "2026-09-01", end: "2026-09-30", due: 3000, dueDate: "2026-09-10", daysOverdue: 65 }]);
  });

  it("the part being billed now (or later) is never 'earlier'; one proforma over two rows is listed once, oldest first", () => {
    const nov = row({ id: "b-nov", period_start: "2026-11-01", period_end: "2026-12-01" });
    const octB = row({ id: "b-oct2", period_start: "2026-10-01", period_end: "2026-11-01", due_on: "2026-10-01" });
    const aug = row({ id: "b-aug", period_start: "2026-08-01", period_end: "2026-09-01", due_on: "2026-08-01" });
    const r = earlierUnpaidParts({
      rows: [nov, OCT, octB, aug],
      quotes: [
        quote({ id: "PI-NOV", subscription_billing_id: "b-nov" }),
        quote({ id: "PI-OCT", subscription_billing_id: "b-oct" }), quote({ id: "PI-OCT", subscription_billing_id: "b-oct2" }),
        quote({ id: "PI-AUG", subscription_billing_id: "b-aug", status: "viewed" }),
      ],
      invoices: [], firstStart: "2026-11-01", todayISO: TODAY,
    });
    expect(r.map((p) => p.id)).toEqual(["PI-AUG", "PI-OCT"]);
  });

  it("void / written-off invoice → not owed", () => {
    for (const inv of [
      { id: "INV-9", status: "void", amount: 3835 },
      { id: "INV-9", status: "sent", amount: 3835, written_off_at: "2026-10-30T00:00:00Z" },
    ]) {
      expect(earlierUnpaidParts({ rows: [SEP], quotes: [], invoices: [inv], firstStart: "2026-11-01", todayISO: TODAY })).toEqual([]);
    }
  });
});

describe("R-2757 labels", () => {
  it("'Periods' says what it counts", () => {
    expect(periodsToBillLabel("monthly")).toBe("Months to bill");
    expect(periodsToBillLabel("quarterly")).toBe("Quarters to bill");
    expect(periodsToBillLabel("yearly")).toBe("Years to bill");
  });
  it("button month word: Nov, Nov–Jan", () => {
    expect(billMonthsWord([{ start: "2026-11-01", end: "2026-11-30" }])).toBe("Nov");
    expect(billMonthsWord([{ start: "2026-11-01", end: "2026-11-30" }, { start: "2027-01-01", end: "2027-01-31" }])).toBe("Nov–Jan");
  });
});
