/**
 * R-1763 — an imported Zoho subscription (ska-group-like, the owner's drawer on 22 Oct):
 * "From Zoho Books · INV-… (date)", this term "Billed in Zoho · INV-…" — never "date passed",
 * never "next", never invoiced again by the billing cron; the next term is normal.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { billedElsewhere, billedElsewhereLabel, externalSourceText } from "./billed-elsewhere";
import { scheduleInvoices, nextUninvoiced, nextTermShowsNext } from "@/components/features/subscriptions/schedule-invoices";
import { subscriptionSchedule, nextTermSchedule } from "@/lib/billing/subscription-schedule";
import { syncSubscriptionInstalments, type InstalmentSub } from "@/lib/billing/sync-instalments.server";

/* Imported: Zoho invoice INV-T-000871 of 22 Jun 2026 covers 20 Jun 2026 – 19 Jun 2027. */
const imported = {
  mrr: 600, billing_cycle: "yearly" as const, term_months: 12,
  start_date: "2025-06-20", renewal_date: "2027-06-19",
  external_source: "zoho_books", external_ref: "INV-T-000871", external_ref_date: "2026-06-22",
  billed_externally_until: "2027-06-19",
};

describe("R-1763 — the drawer of an imported subscription", () => {
  it("says where it came from", () => {
    expect(externalSourceText(imported)).toBe("From Zoho Books · INV-T-000871 (22 Jun 2026)");
    expect(externalSourceText({ external_source: null })).toBeNull();
  });

  it("this term is 'Billed in Zoho · INV-…', not date passed / next; the next term is the next bill", () => {
    const today = "2026-10-22";
    const periods = subscriptionSchedule(imported);
    expect(periods[0].billOn).toBe("2026-06-20");                      // a passed date…
    const m = scheduleInvoices({ periods, startDate: imported.start_date, saleInvoice: null, instalments: [], source: imported });
    expect(m.get(1)).toMatchObject({ invoiceId: "INV-T-000871", externalLabel: "Billed in Zoho · INV-T-000871" });
    expect(nextUninvoiced(periods, m, today)).toBeNull();              // …that is billed, not "next"
    expect(nextTermShowsNext(periods, m, today)).toBe(true);           // the renewal is the next bill
    expect(billedElsewhere(imported, nextTermSchedule(imported)[0].periodStart)).toBe(false);
    expect(billedElsewhereLabel(imported)).toBe("Billed in Zoho · INV-T-000871");
  });

  it("a subscription made here is unchanged", () => {
    const here = { ...imported, external_source: null, external_ref: null, external_ref_date: null, billed_externally_until: null };
    const periods = subscriptionSchedule(here);
    const m = scheduleInvoices({ periods, startDate: here.start_date, saleInvoice: null, instalments: [], source: here });
    expect(m.size).toBe(0);
  });
});

describe("R-1763 — the billing cron never invoices the term Zoho billed", () => {
  /* Any database call fails the test: the imported term must be skipped before one is made. */
  const noDb = new Proxy({}, { get() { throw new Error("database touched"); } }) as unknown as SupabaseClient;

  it("monthly imported subscription, this month billed in Zoho → skipped with the reason", async () => {
    const sub: InstalmentSub = {
      id: "s1", tenant_id: "t1", quote_id: null, mrr: 300, billing_cycle: "monthly", term_months: 1,
      start_date: "2026-10-01", renewal_date: "2026-10-31",
      external_source: "zoho_books", external_ref: "INV-T-000990", billed_externally_until: "2026-10-31",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await syncSubscriptionInstalments({ supabase: noDb as any, sub, quote: undefined, todayISO: "2026-10-22" });
    expect(r.skip).toEqual({ code: "billed_elsewhere", reason: "Billed in Zoho · INV-T-000990 — this term is not invoiced again here; the next term is." });
    expect(r.raised).toEqual([]);
  });
});
