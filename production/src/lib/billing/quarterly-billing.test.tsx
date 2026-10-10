// @vitest-environment jsdom
/* ─────────────────────────────────────────────────────────────────────────────
   R-527 — annual commitment billed QUARTERLY, end to end, on the numbers Pardeep's test
   measured on 9 Oct 2026 (Q-FBB9-27-0020: Starter × 8 @ ₹3,240/seat/yr, ₹25,920 ex-GST,
   quotes.amount ₹30,586, billing_cycle quarterly).

   Before: editor ₹7,647/qtr, customer page ₹7,646, PDF CGST/SGST of the year ÷ 4, payment
   sheet "Expected ₹30,586", OWED ₹22,940 after paying Q1, seat add charged to renewal.
   After: ONE per-instalment figure (₹6,480 + round(₹1,166.40) = ₹7,646 — what the Q1 tax
   invoice from raise_subscription_billing carries; see supabase/tests/
   split_billed_outstanding.test.sql), on every document, from lib/billing/instalments.ts.
   ───────────────────────────────────────────────────────────────────────────── */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@react-pdf/renderer", () => {
  const strip = ({ children }: { children?: React.ReactNode }) => children;
  const box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const text = ({ children }: { children?: React.ReactNode }) => <span>{children}</span>;
  return {
    Document: strip, Page: box, View: box, Text: text, Image: () => null,
    StyleSheet: { create: <T,>(x: T) => x },
    Font: { register: () => {}, registerHyphenationCallback: () => {} },
  };
});

import {
  quoteInstalments, quoteInstalmentPlan, splitDue, planForQuote, instalmentGross,
} from "./instalments";
import { grossAmount } from "@/lib/quotes/amounts";
import { splitExpectation, splitOutcomeSentence, splitPaymentToast } from "@/lib/payments/split-expected";
import { seatChargeWindow } from "@/lib/subscriptions/seat-charge-window";
import { previewCharge } from "@/lib/subscriptions/seat-request";
import { nextUninvoiced, nextTermShowsNext } from "@/components/features/subscriptions/schedule-invoices";
import { subscriptionSchedule, nextTermSchedule } from "./subscription-schedule";
import { acceptedPayNow } from "@/app/(public)/quote/[id]/accept/accepted-pay";
import { QuotePDF } from "@/lib/pdf/QuotePDF";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";
import { rupee } from "@/lib/utils";
import type { BillingCycle, QuoteLineItem } from "@/lib/supabase/database.types";

afterEach(cleanup);

/** The quote row as stored (local ANUTECH tenant, 9 Oct 2026). */
const Q = {
  subtotal: 25_920, discount_pct: 0, tax_rate: 18, amount: 30_586,
  billing_cycle: "quarterly" as BillingCycle,
  line_items: [{ id: "l1", name: "Google Workspace Business Starter", qty: 8, rate: 3240, cost: 1320, commitment: "annual_yearly" }],
};
const START = "2026-10-09";

describe("one plan, four quarters", () => {
  const plan = planForQuote(Q, START)!;

  it("4 rows, ₹6,480 + ₹1,166 = ₹7,646 each, dated a quarter apart", () => {
    expect(plan.count).toBe(4);
    expect(plan.lines.map((l) => l.billOn)).toEqual(["2026-10-09", "2027-01-09", "2027-04-09", "2027-07-09"]);
    for (const l of plan.lines) expect([l.taxable, l.tax, l.gross]).toEqual([6480, 1166, 7646]);
    expect(plan.instalmentsGross).toBe(30_584);
  });

  it("the per-instalment figure is the tax invoice's: taxable + round(taxable × 18%)", () => {
    /* raise_subscription_billing: v_tax := round(taxable * rate / 100.0). Same rule for any
       taxable, including the .5 cases where float and numeric rounding could part ways. */
    for (const t of [6480, 2160, 12960, 2025, 2775, 1, 99_999]) {
      expect(instalmentGross(t, 18)).toBe(t + Math.round((t * 18) / 100));
      expect(instalmentGross(t, 18)).toBe(grossAmount(t, 18));
    }
  });

  it("the summary the pay button charges agrees with the plan", () => {
    const s = quoteInstalments({ cycle: "quarterly", termTaxable: 25_920, termGross: 30_586, taxRate: 18, lineCommitment: "annual_yearly" })!;
    expect(s.firstGross).toBe(plan.lines[0].gross);
    expect(s.instalmentsGross).toBe(plan.instalmentsGross);
    const pay = acceptedPayNow({
      quote: { ...Q, currency: "INR", payment_status: "none", invoice_id: null },
      firstCommitment: "annual_yearly", payOnline: true, hasUpi: false,
    });
    expect(pay?.amount).toBe(7646);
  });
});

describe("OWED counts only instalments that have fallen due", () => {
  const plan = planForQuote(Q, START)!;
  it("day one: Q1 ₹7,646 due; paying it leaves ₹0, not ₹22,940", () => {
    expect(splitDue(plan, { todayISO: START, received: 0 }).dueGross).toBe(7646);
    const paid = splitDue(plan, { todayISO: START, received: 7646 });
    expect(paid.outstanding).toBe(0);
    expect(paid.next?.index).toBe(2);
  });
  it("on Q2's date ₹7,646 more is due", () => {
    const d = splitDue(plan, { todayISO: "2027-01-09", received: 7646 });
    expect([d.dueCount, d.dueGross, d.outstanding]).toEqual([2, 15_292, 7646]);
  });
  it("monthly and half-yearly run through the same code", () => {
    const m = planForQuote({ ...Q, billing_cycle: "monthly" }, START)!;
    expect([m.count, m.lines[0].gross]).toEqual([12, 2549]);   // 2,160 + round(388.8)
    const h = planForQuote({ ...Q, billing_cycle: "half_yearly" }, START)!;
    expect([h.count, h.lines[0].gross]).toEqual([2, 15_293]); // 12,960 + round(2,332.8)
    expect(planForQuote({ ...Q, billing_cycle: "yearly" }, START)).toBeNull();
    expect(planForQuote({ ...Q, line_items: [{ ...Q.line_items[0], commitment: "monthly" }] }, START)).toBeNull();
  });
});

describe("Record payment sheet", () => {
  it("expects Q1 only, says so, and never 'fully paid'", () => {
    const e = splitExpectation({ quote: Q, termStart: null, todayISO: START, alreadyReceived: 0 })!;
    expect(e.expected).toBe(7646);
    expect(e.dueLabel).toBe("Instalment 1 of 4");
    expect(e.scheduleLabel).toBe("billed quarterly");
    const s = splitOutcomeSentence(e, { kind: "full", due: 0, excess: 0, formatRupee: rupee });
    expect(s).not.toMatch(/fully paid/i);
    expect(s).toMatch(/Next instalment ₹7,646/);
  });
  it("a yearly quote is not split — the sheet keeps the quote total", () => {
    expect(splitExpectation({ quote: { ...Q, billing_cycle: "yearly" }, termStart: null, todayISO: START, alreadyReceived: 0 })).toBeNull();
  });
  it("the toast drops the RPC's year-level 'outstanding' and names the instalment invoice", () => {
    const e = splitExpectation({ quote: Q, termStart: null, todayISO: START, alreadyReceived: 0 })!;
    const t = splitPaymentToast(
      { tone: "success" as const, title: "Payment recorded · ₹22,940 still pending", lines: ["₹22,940 outstanding — balance pending."] },
      { split: e, receivedAfter: 7646, raise: { raised: [{ invoice_id: "INV-T-1", period_index: 1, gross: 7646 }], errors: [] }, formatRupee: rupee, formatDate: (d) => d },
    );
    expect(t.title).toBe("Instalment paid");
    expect(t.lines.join(" ")).not.toMatch(/22,940/);
    expect(t.lines[0]).toMatch(/INV-T-1 issued for instalment 1 of 4/);
  });
});

/** Text next to a label in a rendered document. */
function valueFor(container: HTMLElement, label: string): string {
  const el = Array.from(container.querySelectorAll("span")).find((s) => s.textContent?.trim() === label);
  expect(el, `${label} not found`).toBeTruthy();
  return el!.parentElement!.textContent!.replace(label, "").trim().replace(/^Rs\s?/, "₹");
}

describe("preview + PDF print the same quarter as the invoice (rounding parity)", () => {
  const docProps = {
    tenantName: "ANUTECH DIGITAL PVT LTD", quoteId: "Q-FBB9-27-0020", customerName: "T-AQ Sharma Associates",
    lineItems: Q.line_items as unknown as QuoteLineItem[],
    subtotal: 25_920, discountPct: 0, discount: 0, taxable: 25_920, taxRate: 18, tax: 4666, total: 30_586,
    interState: false, billingCycle: "quarterly" as BillingCycle, validityDays: 30,
  };

  it("PDF: ₹7,646/qtr = ₹6,480 + ₹583 + ₹583; year ₹30,584", () => {
    const { container } = render(<QuotePDF {...docProps} />);
    expect(valueFor(container, "Per invoice (4/yr)")).toBe("₹7,646/qtr");
    expect(valueFor(container, "CGST (9%)")).toBe("₹583/qtr");
    expect(valueFor(container, "SGST (9%)")).toBe("₹583/qtr");
    expect(valueFor(container, "Taxable amount")).toBe("₹6,480/qtr");
    expect(valueFor(container, "Annual contract value")).toBe("₹30,584/yr");
  });

  it("preview: the same figures", () => {
    render(<QuotePreviewDialog open onOpenChange={() => {}} notes="" {...docProps} />);
    expect(valueFor(document.body, "CGST (9%)")).toBe("₹583/qtr");
    expect(valueFor(document.body, "Taxable amount")).toBe("₹6,480/qtr");
    expect(document.body.textContent).toContain("₹7,646/qtr");
    expect(document.body.textContent).not.toContain("₹7,647");
  });

  it("billed yearly prints the whole year, as before", () => {
    const { container } = render(<QuotePDF {...docProps} billingCycle="yearly" />);
    expect(valueFor(container, "Grand total")).toBe("₹30,586");
  });
});

describe("seat add on a quarterly subscription charges this quarter only", () => {
  const sub = { mrr: 2160, seats: 8, billing_cycle: "quarterly" as BillingCycle, term_months: 12, start_date: START, renewal_date: "2027-10-09" };

  it("window ends with Q1 (8 Jan 2027), over the 365-day term", () => {
    const w = seatChargeWindow(sub, START)!;
    expect(w).toEqual({ remainingDays: 92, termDays: 365, chargeTo: "2027-01-08", instalmentPeriod: true });
    const c = previewCharge({ currentSeats: 8, currentMrr: 2160, seatsToAdd: 1, remainingDays: w.remainingDays, termDays: w.termDays, taxRatePct: 18 })!;
    /* ₹3,240 a seat-year × 92/365 = ₹816.66 → ₹817 ex-GST — a quarter, not the year
       (to renewal it was ₹3,240 + GST = ₹3,823). */
    expect(c.exGst).toBe(817);
    expect(c.total).toBeLessThan(1000);
  });

  it("mid-Q2 the window is the rest of Q2", () => {
    const w = seatChargeWindow(sub, "2027-02-08")!;
    expect([w.remainingDays, w.chargeTo]).toEqual([60, "2027-04-08"]);
  });

  it("yearly still charges to renewal", () => {
    const w = seatChargeWindow({ ...sub, billing_cycle: "yearly" }, START)!;
    expect([w.remainingDays, w.chargeTo, w.instalmentPeriod]).toEqual([365, "2027-10-09", false]);
  });
});

describe("the 'next' tag sits on one row only", () => {
  const sub = { mrr: 2160, billing_cycle: "quarterly" as BillingCycle, term_months: 12, start_date: START, renewal_date: "2027-10-09" };
  it("Q1 un-invoiced → Q1 is next and the next term carries no tag", () => {
    const current = subscriptionSchedule(sub);
    expect(nextTermSchedule(sub)[0].billOn).toBe("2027-10-09");
    expect(nextUninvoiced(current, new Map(), START)).toBe(1);
    expect(nextTermShowsNext(current, new Map(), START)).toBe(false);
  });
  it("Q1 invoiced → Q2 is next", () => {
    const current = subscriptionSchedule(sub);
    const inv = new Map([[1, { invoiceId: "INV-1", status: "paid" }]]);
    expect(nextUninvoiced(current, inv, START)).toBe(2);
  });
});

describe("the plan follows the term start it is given", () => {
  it("a plan from a later start keeps the same amounts", () => {
    const a = quoteInstalmentPlan({ cycle: "quarterly", termTaxable: 25_920, termGross: 30_586, taxRate: 18, termStart: "2026-10-09" })!;
    const b = quoteInstalmentPlan({ cycle: "quarterly", termTaxable: 25_920, termGross: 30_586, taxRate: 18, termStart: "2027-03-31" })!;
    expect(a.lines.map((l) => l.gross)).toEqual(b.lines.map((l) => l.gross));
    expect(b.lines[1].billOn).toBe("2027-06-30");
  });
});

describe("quote page money line", () => {
  it("Q1 paid → no '₹22,940 still outstanding'; offers the next instalment", async () => {
    const { quoteMoneyActions } = await import("@/lib/quotes/money-stage");
    const plan = planForQuote(Q, START)!;
    const d = splitDue(plan, { todayISO: START, received: 7646 });
    const m = quoteMoneyActions({
      status: "accepted", paymentStatus: "partial", invoiceId: null, total: 30_586, received: 7646,
      splitBilledCycle: "quarterly",
      splitDue: { dueGross: d.dueGross, outstanding: d.outstanding, count: plan.count,
        next: d.next ? { gross: d.next.gross, billOn: "9 Jan 2027", index: d.next.index } : null },
    }, rupee);
    expect(m.outstanding).toBe(0);
    expect(m.note).not.toMatch(/22,940/);
    expect(m.note).toMatch(/Next instalment ₹7,646 \(2 of 4\) on 9 Jan 2027/);
    expect(m.recordLabel).toBe("Record next instalment");
  });
  it("nothing paid yet → ₹7,646 due now, not ₹30,586", async () => {
    const { quoteMoneyActions } = await import("@/lib/quotes/money-stage");
    const plan = planForQuote(Q, START)!;
    const d = splitDue(plan, { todayISO: START, received: 0 });
    const m = quoteMoneyActions({
      status: "accepted", paymentStatus: "none", invoiceId: null, total: 30_586, received: 0,
      splitBilledCycle: "quarterly",
      splitDue: { dueGross: d.dueGross, outstanding: d.outstanding, count: plan.count, next: null },
    }, rupee);
    expect(m.outstanding).toBe(7646);
    expect(m.note).toMatch(/^₹7,646 due now/);
  });
});
