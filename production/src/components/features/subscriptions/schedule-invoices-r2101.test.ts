/* R-2101 (29 Oct 2026, localhost check of efbce1ecc) — the subscription drawer's Billing schedule
   after a 2-subscription quarterly sale (Starter 57 × ₹3,200/yr + Standard 13 × ₹11,000/yr) got
   ONE combined Q1 invoice:
     · the Standard's parts read ₹35,751 × 4 (from mrr 11,917) where the quote says ₹35,750;
     · its footer said each tax invoice is raised on its billing date — the quote page says it is
       raised when the part is paid;
     · an Opening subscription (billed outside, R-1763) read "1 billing date · 1 invoiced". */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { subscriptionSchedule } from "@/lib/billing/subscription-schedule";
import {
  quoteTermAmount, scheduleCountLabel, scheduleCounts, scheduleFootnote, scheduleInvoices, type ScheduleInvoice,
} from "./schedule-invoices";

const QUOTE = {
  discount_pct: 0,
  line_items: [
    { name: "Google Workspace Business Starter", qty: 57, rate: 3200, commitment: "annual_quarterly" },
    { name: "Google Workspace Business Standard", qty: 13, rate: 11000, commitment: "annual_quarterly" },
  ],
};
const STANDARD = {
  mrr: 11917, billing_cycle: "quarterly" as const, term_months: 12,
  start_date: "2026-10-22", renewal_date: null,
};

describe("parts not invoiced yet show the quote's period figure (R-2101)", () => {
  it("Standard 13 × ₹11,000 → ₹1,43,000 a year → ₹35,750 a quarter, not ₹35,751", () => {
    const term = quoteTermAmount({ plan: "Google Workspace Business Standard", seats: 13, mrr: 11917, termMonths: 12, quote: QUOTE });
    expect(term).toBe(143000);
    expect(subscriptionSchedule(STANDARD, term).map((p) => p.amount)).toEqual([35750, 35750, 35750, 35750]);
    expect(subscriptionSchedule(STANDARD).map((p) => p.amount)).toEqual([35751, 35751, 35751, 35751]);
  });
  it("a real price change, a discount or no matching line → the mrr figure", () => {
    expect(quoteTermAmount({ plan: "Google Workspace Business Standard", seats: 14, mrr: 12833, termMonths: 12, quote: QUOTE })).toBeNull();
    expect(quoteTermAmount({ plan: "Google Workspace Business Standard", seats: 13, mrr: 12000, termMonths: 12, quote: QUOTE })).toBeNull();
    expect(quoteTermAmount({ plan: "Google Workspace Business Standard", seats: 13, mrr: 11917, termMonths: 12, quote: { ...QUOTE, discount_pct: 5 } })).toBeNull();
    expect(quoteTermAmount({ plan: "Google Workspace Business Standard", seats: 13, mrr: 11917, termMonths: 12, quote: null })).toBeNull();
  });
  it("the card lays the sale term from it", () => {
    const src = readFileSync(join(__dirname, "billing-schedule-card.tsx"), "utf8");
    expect(src).toMatch(/subscriptionSchedule\(subscription, saleTermAmount\)/);
  });
});

describe("a combined invoice shows this subscription's share (R-2101)", () => {
  it("Q1 invoice ₹81,350 ex-GST covers both; the Standard's row shows ₹35,750", () => {
    const periods = subscriptionSchedule(STANDARD, 143000);
    const inv = scheduleInvoices({
      periods, startDate: "2026-10-22", saleInvoice: null,
      instalments: [{ term_start: "2026-10-22", period_index: 1, invoice_id: "INV-1111-27-0016", invoice_status: "paid", invoice_ex_gst: 81350, part_ex_gst: 35750 }],
    });
    expect(inv.get(1)?.exGst).toBe(35750);
  });
});

describe("the footer says what the quote page says (R-2101)", () => {
  it("billed in parts → payment request on its date, tax invoice when paid", () => {
    expect(scheduleFootnote("quarterly")).toBe(
      "Amounts without an invoice number are not invoiced yet. Billed in parts: each part gets a payment request on its date; its tax invoice is raised when paid.",
    );
    expect(scheduleFootnote("quarterly")).not.toMatch(/on its own billing date/);
  });
  it("yearly keeps the old sentence", () => {
    expect(scheduleFootnote("yearly")).toMatch(/raised on its own billing date/);
  });
});

describe("an Opening term billed outside is not 'invoiced' (R-2101)", () => {
  it("1 billing date · 1 billed outside", () => {
    const periods = subscriptionSchedule({ ...STANDARD, billing_cycle: "yearly" });
    const inv = new Map<number, ScheduleInvoice>([[periods[0].index, { invoiceId: "INV-000871", status: "external", externalLabel: "Billed in Zoho · INV-000871" }]]);
    const c = scheduleCounts(periods, inv);
    expect(c).toEqual({ invoiced: 0, billedOutside: 1 });
    expect(scheduleCountLabel(periods.length, c.invoiced, 0, c.billedOutside)).toBe("1 billing date · 1 billed outside");
  });
});
