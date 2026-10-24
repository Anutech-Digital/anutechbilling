/**
 * R-1133 — characterization test for the quote-level discount maths (23 Oct 2026).
 *
 * Two formulas are live today:
 *   Form A  discount = Math.round(S * (p / 100))   — quoteAmounts (PDF), quoteTotal (pay
 *           intent) and 12 more hand-written copies (see discount-copies.scan.test.ts).
 *   Form B  discount = Math.round(S * p / 100)     — taxableAfterDiscount and SQL
 *           generate_invoice (the TAX INVOICE), and so planForQuote / quoteDueNow.
 * In floating point S*(p/100) can land just under .5 (50 × 0.29 = 14.499999…) where S*p/100
 * is exactly 14.5, so Form A rounds DOWN and Form B rounds UP: Form A's taxable value is
 * ₹1 higher. Integer p 0–30 × S 1–1,00,000: 309 such quotes, all at 29%.
 *
 * This file PINS today's behaviour, the disagreement included, so the open decision on the
 * card (switch every Form A copy to Form B?) is a visible, reviewed change to this file and
 * never a silent drift. When Pardeep says yes, the Form A pins below flip to the Form B
 * figures and KNOWN_A_MINUS_B becomes 0.
 *
 * It also proves the R-1133 safe refactor: the three hand-written Form B copies
 * (instalments.ts planForQuote, quote-due-now.ts, quote-accept-view.tsx dueToday) now call
 * taxableAfterDiscount and give the identical figure for every whole-rupee subtotal
 * (quotes.subtotal is an Int column; discount_pct a SmallInt).
 */
import { describe, expect, it } from "vitest";
import { taxableAfterDiscount } from "./amounts";
import { quoteAmounts } from "@/lib/pdf/build-props";
import { quoteTotal } from "@/app/(app)/quotes/[id]/pay-intent";
import { planForQuote, quoteInstalments } from "@/lib/billing/instalments";
import { quoteDueNow } from "@/lib/payments/quote-due-now";

/** Form A exactly as the 14 baseline copies write it. */
const formATaxable = (S: number, p: number) => S - Math.round(S * (p / 100));

/* The three Form B copies exactly as they were written before R-1133. */
const oldInstalments  = (subtotalRaw: number | null, pct: number | null) => {
  const subtotal = Math.round(subtotalRaw ?? 0);
  return subtotal - Math.round((subtotal * (pct ?? 0)) / 100);
};
const oldQuoteDueNow  = (subtotal: number, discountPct: number) => subtotal - Math.round(subtotal * discountPct / 100);
const oldAcceptView   = (s: number | null, p: number | null) => (s ?? 0) - Math.round((s ?? 0) * (p ?? 0) / 100);

/** The ₹1 edge cases (subtotal, pct) — Form A taxable is one rupee above Form B's. */
const EDGES: ReadonlyArray<{ S: number; p: number; formA: number; formB: number }> = [
  { S: 50,   p: 29, formA: 36,   formB: 35 },
  { S: 750,  p: 29, formA: 533,  formB: 532 },
  { S: 1450, p: 29, formA: 1030, formB: 1029 },
  { S: 90,   p: 35, formA: 59,   formB: 58 },
];
/** Ordinary quotes where both forms agree. */
const AGREE: ReadonlyArray<{ S: number; p: number; taxable: number }> = [
  { S: 600,   p: 10, taxable: 540 },
  { S: 1000,  p: 15, taxable: 850 },
  { S: 30000, p: 29, taxable: 21300 },
  { S: 25920, p: 0,  taxable: 25920 },
];

/** Form A taxable − Form B taxable at the edges. Becomes 0 once the decision lands. */
const KNOWN_A_MINUS_B = 1;

describe("R-1133 — the two discount formulas today", () => {
  it("taxableAfterDiscount (Form B, the invoice's) on the edge cases and ordinary quotes", () => {
    for (const e of EDGES) expect(taxableAfterDiscount(e.S, e.p)).toBe(e.formB);
    for (const a of AGREE) expect(taxableAfterDiscount(a.S, a.p)).toBe(a.taxable);
  });

  it("Form A gives ₹1 MORE taxable value at the .5 edges — the known, recorded difference", () => {
    for (const e of EDGES) {
      expect(formATaxable(e.S, e.p)).toBe(e.formA);
      expect(formATaxable(e.S, e.p) - taxableAfterDiscount(e.S, e.p)).toBe(KNOWN_A_MINUS_B);
    }
    for (const a of AGREE) expect(formATaxable(a.S, a.p)).toBe(a.taxable);
  });

  it("how often they disagree: 309 quotes in subtotal ₹1–₹1,00,000 × 0–30%, all at 29%, always +₹1", () => {
    let count = 0;
    const pcts = new Set<number>();
    const gaps = new Set<number>();
    for (let p = 0; p <= 30; p++) {
      for (let S = 1; S <= 100_000; S++) {
        const gap = formATaxable(S, p) - taxableAfterDiscount(S, p);
        if (gap !== 0) { count++; pcts.add(p); gaps.add(gap); }
      }
    }
    expect(count).toBe(309);
    expect([...pcts]).toEqual([29]);
    expect([...gaps]).toEqual([KNOWN_A_MINUS_B]);
  });
});

describe("R-1133 — today's results of the money helpers (pinned)", () => {
  it("quoteAmounts (quote PDF) uses Form A", () => {
    expect(quoteAmounts({ subtotal: 50, discount_pct: 29, tax_rate: 18, amount: null }))
      .toEqual({ subtotal: 50, discountPct: 29, discount: 14, taxable: 36, taxRate: 18, tax: 6, total: 42 });
    expect(quoteAmounts({ subtotal: 1450, discount_pct: 29, tax_rate: 18, amount: null }))
      .toEqual({ subtotal: 1450, discountPct: 29, discount: 420, taxable: 1030, taxRate: 18, tax: 185, total: 1215 });
    expect(quoteAmounts({ subtotal: 600, discount_pct: 10, tax_rate: 18, amount: 637 }))
      .toEqual({ subtotal: 600, discountPct: 10, discount: 60, taxable: 540, taxRate: 18, tax: 97, total: 637 });
    for (const e of EDGES) {
      expect(quoteAmounts({ subtotal: e.S, discount_pct: e.p, tax_rate: 18, amount: null }).taxable).toBe(e.formA);
    }
  });

  it("quoteTotal (Record-payment dialog) uses Form A when no amount is stored", () => {
    expect(quoteTotal({ subtotal: 50, discount_pct: 29, tax_rate: 18, amount: null })).toBe(42);
    expect(quoteTotal({ subtotal: 1450, discount_pct: 29, tax_rate: 18, amount: null })).toBe(1215);
    expect(quoteTotal({ subtotal: 600, discount_pct: 10, tax_rate: 18, amount: null })).toBe(637);
    expect(quoteTotal({ subtotal: 600, discount_pct: 10, tax_rate: 18, amount: 700 })).toBe(700);
  });

  it("planForQuote (split billing) uses Form B — the invoice's taxable value", () => {
    const plan = planForQuote(
      { subtotal: 1450, discount_pct: 29, tax_rate: 18, amount: 1214, billing_cycle: "quarterly", line_items: [] },
      "2026-11-01",
    );
    expect(plan?.count).toBe(4);
    expect(plan?.lines.reduce((s, l) => s + l.taxable, 0)).toBe(1029);      // Form B, not 1030
    expect(planForQuote({ subtotal: 1450, discount_pct: 29, tax_rate: 18, amount: 1214, billing_cycle: "yearly" }, "2026-11-01")).toBeNull();
  });

  it("quoteDueNow (pay button / Razorpay / UPI) uses Form B for instalment 1", () => {
    const due = quoteDueNow(
      { subtotal: 1450, discount_pct: 29, tax_rate: 18, amount: 1214, billing_cycle: "quarterly", line_items: [] },
      0,
    );
    const split = quoteInstalments({ cycle: "quarterly", termTaxable: 1029, termGross: 1214, taxRate: 18 });
    expect(due.state).toBe("due");
    if (due.state !== "due") return;
    expect(due.amount).toBe(split?.firstGross);
    expect(due.instalment).toEqual({ count: 4, cycle: "quarterly", termGross: split?.instalmentsGross });
    // A yearly quote: the stored total less what was received — no discount maths at all.
    expect(quoteDueNow({ subtotal: 50, discount_pct: 29, tax_rate: 18, amount: 41, billing_cycle: "yearly" }, 0))
      .toMatchObject({ state: "due", amount: 41 });
  });
});

describe("R-1133 — the 3 Form B copies now on taxableAfterDiscount give identical results", () => {
  it("every whole-rupee subtotal ₹0–₹20,000 × every discount 0–100%", () => {
    let checked = 0;
    for (let p = 0; p <= 100; p++) {
      for (let S = 0; S <= 20_000; S++) {
        const helper = taxableAfterDiscount(S, p);
        if (oldInstalments(S, p) !== helper || oldQuoteDueNow(S, p) !== helper || oldAcceptView(S, p) !== helper) {
          throw new Error(`differs at S=${S} p=${p}`);
        }
        checked++;
      }
    }
    expect(checked).toBe(101 * 20_001);
  });

  it("null subtotal / discount (the ?? 0 defaults) still mean ₹0 and 0%", () => {
    expect(taxableAfterDiscount(0, 0)).toBe(oldAcceptView(null, null));
    expect(taxableAfterDiscount(1450, 0)).toBe(oldAcceptView(1450, null));
    expect(taxableAfterDiscount(Math.round(0), 0)).toBe(oldInstalments(null, null));
  });

  it("planForQuote and quoteDueNow match the pre-R-1133 maths on the edges and ordinary quotes", () => {
    for (const { S, p } of [...EDGES, ...AGREE]) {
      for (const cycle of ["monthly", "quarterly", "half_yearly"] as const) {
        const termGross = Math.max(1, Math.round(oldQuoteDueNow(S, p) * 1.18));
        const before = quoteInstalments({ cycle, termTaxable: oldQuoteDueNow(S, p), termGross, taxRate: 18 });
        const due = quoteDueNow({ subtotal: S, discount_pct: p, tax_rate: 18, amount: termGross, billing_cycle: cycle }, 0);
        if (before) {
          expect(due).toMatchObject({ state: "due", amount: before.firstGross });
        }
        const plan = planForQuote({ subtotal: S, discount_pct: p, tax_rate: 18, amount: termGross, billing_cycle: cycle }, "2026-11-01");
        expect(plan?.lines.reduce((s, l) => s + l.taxable, 0) ?? null).toBe(before ? oldInstalments(S, p) : null);
      }
    }
  });
});
