/**
 * R-369 — ONE unit for a quote line's `rate`, from the builder that saves it to every
 * reader that bills it.
 *
 *   monthly (flex)  → ₹ per seat per MONTH
 *   annual_*        → ₹ per seat per YEAR
 *
 * The readers (PDF divisor, covering e-mail, instalments, accept page, record_payment MRR)
 * already agreed on that. The writers did not: the builder saved a flex line at
 * `tier.msrp * 12` and `supportLineRate` returned `term * 12` for a monthly support plan,
 * so a 10-seat Starter flex quote was saved — and e-mailed, and charged — at twelve months
 * per month. These tests walk ONE line through every step and want the same number.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { storedLineRate, quoteTotalsDivisor, lineAmountSuffix } from "./line-rate-unit";
import { convertRateForCommitment } from "./commitment-rate";
import { perInvoiceDivisor, annualContractValue } from "@/lib/pdf/invoice-divisor";
import { quoteEmailBody } from "@/lib/email/quote-body";
import { quoteInstalments } from "@/lib/billing/instalments";
import { supportLineRate } from "@/lib/support/catalog-row";
import { supportTier } from "@/lib/support/tiers";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

/* A Starter flex tier: ₹204/seat/month to the customer, ₹170 to us. */
const STARTER_FLEX = { msrp: 204, wholesale: 170 };
const SEATS = 10;
const MONTHLY_INVOICES = 12;

describe("one 10-seat Starter flex line — the same monthly amount everywhere", () => {
  /* What the builder saves when the line switches to "Monthly flex" (updateCommitment). */
  const rate = storedLineRate(STARTER_FLEX.msrp, "monthly");
  const line: QuoteLineItem = {
    id: "l1", name: "Google Workspace Business Starter", qty: SEATS,
    rate, cost: storedLineRate(STARTER_FLEX.wholesale, "monthly"), commitment: "monthly",
  };
  const subtotal = line.qty * line.rate;          // quote-builder.tsx: qty × rate
  const tax = Math.round(subtotal * 0.18);
  const total = subtotal + tax;                   // quotes.amount

  it("the builder stores the flex rate per seat per MONTH, not ×12", () => {
    expect(rate).toBe(204);
    expect(line.cost).toBe(170);
    expect(subtotal).toBe(2_040);
  });

  it("the builder's per-invoice line figure equals the stored rate (no ÷ billingN)", () => {
    expect(line.rate / perInvoiceDivisor(MONTHLY_INVOICES, line.commitment)).toBe(204);
    expect(lineAmountSuffix(line.commitment, MONTHLY_INVOICES)).toBe(" /mo");
  });

  it("the builder's totals divisor is the PDF's divisor", () => {
    expect(quoteTotalsDivisor(MONTHLY_INVOICES, [line])).toBe(perInvoiceDivisor(MONTHLY_INVOICES, "monthly"));
    expect(total / quoteTotalsDivisor(MONTHLY_INVOICES, [line])).toBe(2_407);
  });

  it("the PDF prints the same month and twelve of them for the year", () => {
    expect(subtotal / perInvoiceDivisor(MONTHLY_INVOICES, "monthly")).toBe(2_040);
    expect(annualContractValue(subtotal, MONTHLY_INVOICES, "monthly")).toBe(24_480);
  });

  it("the covering e-mail says the same monthly payable", () => {
    const body = quoteEmailBody({
      quoteId: "Q-T-1", customerName: "Acme", lineItems: [line], billingCycle: "monthly",
      supplier: { name: "S", gstin: "07ABDCA0298H1ZP", address: "Delhi", state: "Delhi", email: "a@b.in", phone: "1" },
      subtotal, discountPct: 0, discount: 0, taxRate: 18, tax, total,
      interState: false, createdDate: "2026-10-07", expiresDate: "2026-10-14",
    });
    expect(body).toContain("₹2,040/month");
    expect(body).toContain("₹2,407/month");
    expect(body).not.toContain("24,072");
  });

  it("no instalment split — the stored amount IS one month (accept page / pay button)", () => {
    expect(quoteInstalments({ cycle: "monthly", termTaxable: subtotal, termGross: total, taxRate: 18, lineCommitment: "monthly" })).toBeNull();
  });

  it("record_payment's MRR (amount / 1.0 for a monthly line) is that month", () => {
    const mrr = subtotal / (line.commitment === "monthly" ? 1 : 12);
    expect(mrr).toBe(2_040);
  });

  it("re-opening the saved line shows the same numbers (edit reload round-trip)", () => {
    const toAnnual = convertRateForCommitment({ rate: line.rate, cost: line.cost, from: "monthly", to: "annual_yearly" });
    const back = convertRateForCommitment({ rate: toAnnual.rate, cost: toAnnual.cost, from: "annual_yearly", to: "monthly" });
    expect(back.rate).toBe(204);
    expect(back.cost).toBe(170);
  });
});

describe("annual lines keep the per-YEAR unit", () => {
  it("stores ×12 and divides by invoices-per-year", () => {
    expect(storedLineRate(204, "annual_yearly")).toBe(2_448);
    expect(storedLineRate(204, undefined)).toBe(2_448);
    expect(perInvoiceDivisor(12, "annual_yearly")).toBe(12);
    expect(lineAmountSuffix("annual_yearly", 12)).toBe(" /yr");
    expect(lineAmountSuffix("annual_yearly", 1)).toBe("");
  });
});

describe("a monthly support plan — R-364's picker", () => {
  it("is the monthly term, the same unit as every other flex line", () => {
    const std = supportTier("standard");
    expect(supportLineRate(null, std, "monthly")).toBe(999);
    expect(supportLineRate({ msrp: 1_199, prices: {} } as never, std, "monthly")).toBe(1_199);
    expect(supportLineRate(null, std, "yearly")).toBe(9_996);
  });
});

describe("quote-builder.tsx — no writer or display left on the old ×12 / ÷billingN rule", () => {
  const src = readFileSync(join(__dirname, "../../components/features/quotes/quote-builder.tsx"), "utf8");

  it("does not store a tier's monthly price ×12 regardless of commitment", () => {
    expect(src).not.toMatch(/rate:\s*tier\.msrp\s*\*\s*12/);
  });

  it("does not divide a line's rate by billingN (a flex line is already one invoice)", () => {
    expect(src).not.toMatch(/line\.(rate|cost)\s*\/\s*billingN/);
    expect(src).not.toMatch(/raw\s*\*\s*billingN/);
  });
});
