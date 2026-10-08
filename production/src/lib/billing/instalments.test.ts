import { describe, it, expect } from "vitest";
import {
  SPLIT_CYCLES, isSplitBilled, plannedInstalments, instalmentSkip, instalmentsDue,
  quoteInstalments,
} from "./instalments";
import { scheduleTotal } from "./schedule";
import { grossAmount } from "@/lib/quotes/amounts";
import type { BillingCycle } from "@/lib/supabase/database.types";

/** A ₹28,320-incl-GST yearly deal: ₹24,000 ex-GST over 12 months = ₹2,000 mrr. */
const sub = (over: Partial<{
  mrr: number; billing_cycle: BillingCycle; term_months: number;
  start_date: string | null; renewal_date: string | null;
}> = {}) => ({
  mrr:          2_000,
  billing_cycle: "monthly" as BillingCycle,
  term_months:  12,
  start_date:   "2026-08-14",
  renewal_date: "2027-08-14",
  ...over,
});

describe("which subscriptions split", () => {
  it("excludes yearly — it is one period, and the quote path already invoices it", () => {
    /* If this ever includes yearly, every yearly subscription gets invoiced twice:
       once from its quote and once from an instalment. The database trigger in
       20260817110200 draws the same line and the two must agree. */
    expect(isSplitBilled("yearly")).toBe(false);
    expect(SPLIT_CYCLES).not.toContain("yearly");
  });

  it("includes every cycle that produces more than one invoice a year", () => {
    for (const c of ["monthly", "quarterly", "half_yearly"] as BillingCycle[]) {
      expect(isSplitBilled(c)).toBe(true);
    }
  });

  it("treats a missing cycle as not split, rather than guessing", () => {
    expect(isSplitBilled(null)).toBe(false);
    expect(isSplitBilled(undefined)).toBe(false);
  });
});

describe("plannedInstalments", () => {
  it("lays 12 instalments across a monthly year", () => {
    const rows = plannedInstalments(sub());
    expect(rows).toHaveLength(12);
    expect(rows[0].periodIndex).toBe(1);
    expect(rows[11].periodIndex).toBe(12);
  });

  it("the instalments add up to the term — no rupee invented or lost", () => {
    /* The whole point of splitting. A schedule whose parts do not sum to the term
       means the customer is billed a different total depending on their cycle. */
    for (const cycle of SPLIT_CYCLES) {
      const rows = plannedInstalments(sub({ billing_cycle: cycle }));
      const total = rows.reduce((s, r) => s + r.taxableAmount, 0);
      expect(total).toBe(24_000);
    }
  });

  it("matches the schedule the portal already shows the customer", () => {
    /* Same engine, so a customer cannot be shown one forecast and invoiced another. */
    const rows = plannedInstalments(sub({ billing_cycle: "quarterly" }));
    expect(rows).toHaveLength(4);
    expect(scheduleTotal(rows.map((r) => ({
      index: r.periodIndex, billOn: r.billOn,
      periodStart: r.periodStart, periodEnd: r.periodEnd, amount: r.taxableAmount,
    })))).toBe(24_000);
  });

  it("anchors term_start on the first period so a renewal cannot collide", () => {
    /* period_index restarts at 1 each term. Without term_start in the key, the
       renewal's instalment 1 collides with the original's and never bills. */
    const first  = plannedInstalments(sub());
    const second = plannedInstalments(sub({ start_date: "2027-08-14", renewal_date: "2028-08-14" }));
    expect(first[0].periodIndex).toBe(second[0].periodIndex);
    expect(first[0].termStart).not.toBe(second[0].termStart);
  });

  it("returns nothing for a yearly subscription", () => {
    expect(plannedInstalments(sub({ billing_cycle: "yearly" }))).toEqual([]);
  });

  it("returns nothing rather than guessing when there are no dates", () => {
    expect(plannedInstalments(sub({ start_date: null, renewal_date: null }))).toEqual([]);
  });
});

describe("instalmentSkip — when billing must NOT run", () => {
  /* R-375 (audit finding 5): a split-billed quote paid IN FULL at the desk can never get a
     whole-term GST invoice (the invoices trigger refuses it). Skipping its instalments as
     well left paid supply with no tax invoice anywhere. raise_subscription_billing credits
     the money already received, so each instalment is issued PAID — not billed twice. */
  it("bills a term collected up front with NO invoice yet — the instalments carry the GST invoice", () => {
    expect(instalmentSkip({
      cycle: "quarterly", quotePaid: 28_320, quoteAmount: 28_320, quoteInvoiced: false, scheduleSize: 4,
    })).toBeNull();
  });

  it("treats an overpaid, uninvoiced term the same way", () => {
    expect(instalmentSkip({
      cycle: "monthly", quotePaid: 28_321, quoteAmount: 28_320, quoteInvoiced: false, scheduleSize: 12,
    })).toBeNull();
  });

  it("refuses when the quote already has a whole-term invoice — instalments would invoice it twice", () => {
    const skip = instalmentSkip({
      cycle: "monthly", quotePaid: 28_320, quoteAmount: 28_320, quoteInvoiced: true, scheduleSize: 12,
    });
    expect(skip?.code).toBe("term_already_invoiced");
    expect(skip?.reason).toMatch(/twice/);
  });

  it("refuses a whole-term-invoiced quote even when only part is collected", () => {
    expect(instalmentSkip({
      cycle: "monthly", quotePaid: 2_360, quoteAmount: 28_320, quoteInvoiced: true, scheduleSize: 12,
    })?.code).toBe("term_already_invoiced");
  });

  it("allows billing when nothing has been collected", () => {
    expect(instalmentSkip({
      cycle: "monthly", quotePaid: 0, quoteAmount: 28_320, quoteInvoiced: false, scheduleSize: 12,
    })).toBeNull();
  });

  it("allows billing when only part has been collected", () => {
    /* One instalment paid is exactly the pay-as-you-go case this exists for. */
    expect(instalmentSkip({
      cycle: "monthly", quotePaid: 2_360, quoteAmount: 28_320, quoteInvoiced: false, scheduleSize: 12,
    })).toBeNull();
  });

  it("names a reason for every skip — never a silent drop", () => {
    const cases = [
      { cycle: "yearly" as BillingCycle, quotePaid: 0, quoteAmount: 100, quoteInvoiced: false, scheduleSize: 1 },
      { cycle: "monthly" as BillingCycle, quotePaid: 0, quoteAmount: 100, quoteInvoiced: false, scheduleSize: 0 },
      { cycle: "monthly" as BillingCycle, quotePaid: 100, quoteAmount: 100, quoteInvoiced: true, scheduleSize: 12 },
    ];
    for (const c of cases) {
      const skip = instalmentSkip(c);
      expect(skip).not.toBeNull();
      expect(skip!.reason.length).toBeGreaterThan(15);
    }
  });

  it("does not treat a zero-amount quote as collected", () => {
    /* paid 0 >= amount 0 is true, and would skip everything on a quote with no
       amount recorded. That is a missing figure, not a settled term. */
    expect(instalmentSkip({
      cycle: "monthly", quotePaid: 0, quoteAmount: 0, quoteInvoiced: false, scheduleSize: 12,
    })).toBeNull();
  });
});

describe("quoteInstalments — what a quote collects today", () => {
  const q = (over: Partial<Parameters<typeof quoteInstalments>[0]> = {}) => quoteInstalments({
    cycle: "monthly", termTaxable: 24_000, termGross: 28_320, taxRate: 18,
    termMonths: 12, ...over,
  });

  it("charges one month of a ₹28,320 year, not the year", () => {
    expect(q()).toEqual({
      cycle: "monthly", count: 12, firstTaxable: 2_000, firstGross: 2_360, termGross: 28_320,
    });
  });

  it("charges one quarter on a quarterly quote", () => {
    const r = q({ cycle: "quarterly" });
    expect(r?.count).toBe(4);
    expect(r?.firstGross).toBe(7_080);
  });

  it("returns null for yearly — there is nothing to split", () => {
    /* The pay route falls back to charging the quote total on null, so this is the
       switch that keeps every existing quote behaving exactly as it does today. */
    expect(q({ cycle: "yearly" })).toBeNull();
    expect(q({ cycle: null })).toBeNull();
  });

  it("FLEX (commitment=monthly) par null — stored amount hi mahine ki vasooli hai", () => {
    /* 1 Sep 2026 ko naapa: Q-ADPL-2026-27-0106 (15 seats flex, ₹4,875+GST = ₹5,753
       PER MONTH stored) par ye engine termTaxable ko SAAL maan kar 12 par baant
       raha tha — pay-button ₹479 maang raha tha, asli ₹5,753. Flex me quote ke
       aankde pehle se per-month hain (quote-body.ts:133 aur record_payment ka
       v_is_monthly — dono yahi seema maante hain), isliye split ka sawal hi nahi:
       null → caller poora quote.amount charge karta hai, har mahine apni invoice. */
    expect(q({ lineCommitment: "monthly", termTaxable: 4_875, termGross: 5_753 })).toBeNull();
    // Committed-annual billed monthly par split pehle jaisa zinda hai.
    expect(q({ lineCommitment: "annual" })?.firstGross).toBe(2_360);
  });

  it("the instalments still add up to the quote total", () => {
    /* A customer who pays 12 instalments must have paid the quote, not the quote
       plus rounding. The schedule carries its remainder into the LAST instalment,
       so only the first is checked here — schedule.test.ts asserts the sum. */
    for (const taxable of [24_000, 24_001, 23_999, 100_000, 7]) {
      const r = quoteInstalments({
        cycle: "monthly", termTaxable: taxable, termGross: grossAmount(taxable, 18),
        taxRate: 18, termMonths: 12,
      });
      if (r == null) continue;
      expect(r.firstGross).toBe(grossAmount(r.firstTaxable, 18));
      expect(r.firstTaxable).toBeLessThanOrEqual(taxable);
    }
  });

  it("refuses a zero or nonsense term rather than charging ₹0", () => {
    expect(q({ termTaxable: 0 })).toBeNull();
    expect(q({ termGross: 0 })).toBeNull();
    expect(q({ termTaxable: Number.NaN })).toBeNull();
  });

  it("returns null when the term is too short to split", () => {
    /* A one-month term billed monthly is one invoice — charging "the first
       instalment" of it is just charging the whole thing, and pretending otherwise
       would show the customer a split that does not exist. */
    expect(q({ termMonths: 1 })).toBeNull();
  });
});

describe("instalmentsDue", () => {
  const rows = [
    { billOn: "2026-08-14", invoiceId: "INV-1" },
    { billOn: "2026-09-14", invoiceId: null },
    { billOn: "2026-10-14", invoiceId: null },
  ];

  it("catches up on a missed period instead of skipping it forever", () => {
    /* `<=` not `===`. Safe because raise_subscription_billing is idempotent. */
    const due = instalmentsDue(rows, "2026-10-20");
    expect(due.map((r) => r.billOn)).toEqual(["2026-09-14", "2026-10-14"]);
  });

  it("never re-raises a period that already has an invoice", () => {
    expect(instalmentsDue(rows, "2027-01-01").some((r) => r.invoiceId != null)).toBe(false);
  });

  it("does not bill a period before its date", () => {
    expect(instalmentsDue(rows, "2026-08-20")).toEqual([]);
  });
});
