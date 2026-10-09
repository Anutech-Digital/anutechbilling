import { describe, it, expect } from "vitest";
import { scheduleInvoices, nextUninvoiced } from "./schedule-invoices";
import { subscriptionSchedule } from "@/lib/billing/subscription-schedule";
import type { Subscription } from "@/lib/supabase/database.types";

const sub = (over: Partial<Subscription> = {}) => ({
  mrr: 2_700, billing_cycle: "yearly" as const, term_months: 12,
  start_date: "2026-10-08", renewal_date: "2027-10-08", ...over,
}) as Subscription;

describe("R-451: Sharma Traders — a paid first year is 'Invoiced', not 'next'", () => {
  const periods = subscriptionSchedule(sub());

  it("the sale quote's invoice marks the first term as invoiced and paid", () => {
    const m = scheduleInvoices({
      periods, startDate: "2026-10-08",
      saleInvoice: { invoiceId: "INV-DEMO-27-0001", status: "paid" }, instalments: [],
    });
    expect(m.get(1)).toEqual({ invoiceId: "INV-DEMO-27-0001", status: "paid" });
    expect(nextUninvoiced(periods, m, "2026-10-08")).toBeNull();
  });

  it("without an invoice, the same row is the next bill (the date logic is unchanged)", () => {
    const m = scheduleInvoices({ periods, startDate: "2026-10-08", saleInvoice: null, instalments: [] });
    expect(m.size).toBe(0);
    expect(nextUninvoiced(periods, m, "2026-10-08")).toBe(1);
  });

  it("the sale invoice does NOT mark a renewed term (that is a later quote)", () => {
    const renewed = subscriptionSchedule(sub({ start_date: "2025-10-08", renewal_date: "2027-10-08" }));
    const m = scheduleInvoices({
      periods: renewed, startDate: "2025-10-08",
      saleInvoice: { invoiceId: "INV-OLD", status: "paid" }, instalments: [],
    });
    expect(m.size).toBe(0);
  });
});

describe("R-451: split-billed terms read the instalment invoices", () => {
  const monthly = sub({ billing_cycle: "monthly", mrr: 810 });
  const periods = subscriptionSchedule(monthly);

  it("matches on (term_start, period_index), including the pre-fix one-day-later key", () => {
    const m = scheduleInvoices({
      periods, startDate: "2026-10-08", saleInvoice: null,
      instalments: [
        { term_start: "2026-10-09", period_index: 1, invoice_id: "INV-1", invoice_status: "paid" },
        { term_start: "2026-10-08", period_index: 2, invoice_id: "INV-2", invoice_status: "pending" },
        { term_start: "2026-10-08", period_index: 3, invoice_id: null, invoice_status: null },
        { term_start: "2025-10-08", period_index: 4, invoice_id: "INV-OLD", invoice_status: "paid" },
        { term_start: "2026-10-08", period_index: 5, invoice_id: "INV-V", invoice_status: "void" },
      ],
    });
    expect([...m.keys()].sort()).toEqual([1, 2]);
    expect(nextUninvoiced(periods, m, "2026-10-08")).toBe(3);
  });
});
