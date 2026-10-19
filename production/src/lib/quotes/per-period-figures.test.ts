// @vitest-environment jsdom
/* ─────────────────────────────────────────────────────────────────────────────
   R-1570 — the covering email and the attached PDF print the SAME per-invoice money.

   Q: annual commitment, billed monthly (what the auto-quote saves: annual_yearly line,
   billing_cycle "monthly"). Email said "PAYABLE EACH MONTH ₹57,348/month" — the year — while
   the PDF's first instalment was ₹4,779/mo. Both now read lib/quotes/per-period-figures.

   This file renders the REAL PDF tree (@react-pdf primitives as div/span, the way
   quote-gst-heads.test.tsx does) and the real email text, and compares every figure.
   ───────────────────────────────────────────────────────────────────────────── */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@react-pdf/renderer", () => {
  const strip = ({ children }: { children?: React.ReactNode }) => children;
  const box = ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children);
  const text = ({ children }: { children?: React.ReactNode }) => React.createElement("span", null, children);
  return {
    Document: strip,
    Page: box,
    View: box,
    Text: text,
    Image: () => null,
    StyleSheet: { create: <T,>(x: T) => x },
    Font: { register: () => {}, registerHyphenationCallback: () => {} },
  };
});

import { QuotePDF } from "@/lib/pdf/QuotePDF";
import { quoteEmailBody } from "@/lib/email/quote-body";
import { quotePerPeriodFigures } from "./per-period-figures";
import type { QuoteLineItem, BillingCycle } from "@/lib/supabase/database.types";

afterEach(cleanup);

interface Case {
  name: string;
  cycle: BillingCycle;
  commitment: string;
  qty: number;
  rate: number;
  discountPct?: number;
  interState?: boolean;
  /** What the customer must see as "payable per invoice". */
  expectGross: number;
}

const CASES: Case[] = [
  /* 15 × ₹3,240/yr = ₹48,600 → ₹4,050 + 18% = ₹4,779 a month. The reported bug. */
  { name: "annual, billed monthly", cycle: "monthly", commitment: "annual_yearly", qty: 15, rate: 3240, expectGross: 4779 },
  { name: "annual, billed quarterly", cycle: "quarterly", commitment: "annual_yearly", qty: 15, rate: 3240, expectGross: 14337 },
  { name: "annual, billed monthly, inter-state + discount", cycle: "monthly", commitment: "annual_yearly", qty: 7, rate: 3240, discountPct: 10, interState: true, expectGross: 2007 },
  /* Flex: stored figures ARE one month — divide by nothing. */
  { name: "monthly flex", cycle: "monthly", commitment: "monthly", qty: 25, rate: 325, expectGross: 9588 },
  { name: "annual, billed yearly", cycle: "yearly", commitment: "annual_yearly", qty: 15, rate: 3240, expectGross: 57348 },
];

function figures(c: Case) {
  const subtotal = c.qty * c.rate;
  const discountPct = c.discountPct ?? 0;
  const discount = Math.round(subtotal * discountPct / 100);
  const taxable = subtotal - discount;
  const tax = Math.round(taxable * 0.18);
  const lineItems = [{ id: "l1", name: "Google Workspace Business Starter", qty: c.qty, rate: c.rate, cost: c.rate, commitment: c.commitment }] as unknown as QuoteLineItem[];
  return { lineItems, subtotal, discountPct, discount, taxable, taxRate: 18, tax, total: taxable + tax };
}

const num = (s: string) => Number(s.replace(/\(.*?\)/g, "").replace(/[^\d.]/g, ""));

function pdfValue(container: HTMLElement, label: string | RegExp): number {
  const el = Array.from(container.querySelectorAll("span")).find((s) => {
    const t = s.textContent?.trim() ?? "";
    return typeof label === "string" ? t === label : label.test(t);
  });
  expect(el, `PDF label ${label} nahi mila`).toBeTruthy();
  const v = Array.from(el!.parentElement!.children).filter((x) => x !== el).map((x) => x.textContent).join("");
  return num(v);
}

function emailValue(body: string, label: string): number {
  const line = body.split("\n").find((l) => l.trimStart().startsWith(label));
  expect(line, `email label ${label} nahi mila`).toBeTruthy();
  return num(line!.trimStart().slice(label.length));
}

describe("R-1570 — email aur PDF ek hi per-invoice raqam chhapte hain", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const f = figures(c);
      const { container } = render(React.createElement(QuotePDF, {
        tenantName: "ANUTECH DIGITAL PVT LTD", quoteId: "Q-R1570", customerName: "Omega Co", validityDays: 7,
        interState: c.interState ?? false, billingCycle: c.cycle, ...f,
      }));
      const body = quoteEmailBody({
        quoteId: "Q-R1570", customerName: "Omega Co", supplier: { name: "ANUTECH DIGITAL PVT LTD", state: "Delhi" },
        lineItems: f.lineItems, billingCycle: c.cycle,
        subtotal: f.subtotal, discountPct: f.discountPct, discount: f.discount, taxRate: 18, tax: f.tax, total: f.total,
        interState: c.interState ?? false, createdDate: "2026-10-18", expiresDate: "2026-10-25",
      });

      const totalLabel = c.cycle === "yearly" ? "TOTAL PAYABLE" : c.cycle === "monthly" ? "PAYABLE EACH MONTH" : "PAYABLE EACH PERIOD";
      const pdfGross = pdfValue(container, /^(Grand total|Per invoice.*)$/);
      expect(pdfGross).toBe(c.expectGross);
      expect(emailValue(body, totalLabel)).toBe(pdfGross);

      expect(emailValue(body, "Taxable value")).toBe(pdfValue(container, /^Subtotal/));
      if (c.interState) {
        expect(emailValue(body, "IGST 18%")).toBe(pdfValue(container, "IGST (18%)"));
      } else {
        expect(emailValue(body, "CGST 9%")).toBe(pdfValue(container, "CGST (9%)"));
        expect(emailValue(body, "SGST 9%")).toBe(pdfValue(container, "SGST (9%)"));
      }
      if (f.discountPct > 0) {
        expect(emailValue(body, `Discount ${f.discountPct}%`)).toBe(pdfValue(container, `Discount (${f.discountPct}%)`));
      }
      if (c.cycle !== "yearly" && c.commitment !== "monthly") {
        expect(emailValue(body, "Annual total")).toBe(pdfValue(container, "Annual contract value"));
      } else {
        expect(body).not.toContain("Annual total");
      }
    });
  }
});

describe("quotePerPeriodFigures — the rules, without a document", () => {
  const base = { subtotal: 48_600, discount: 0, taxable: 48_600, tax: 8_748, total: 57_348, taxRate: 18 };

  it("yearly → the stored term as it is", () => {
    const p = quotePerPeriodFigures({ ...base, cycle: "yearly", lineCommitment: "annual_yearly" });
    expect([p.perInvoice, p.gross, p.yearTotal]).toEqual([false, 57_348, 57_348]);
  });

  it("annual billed monthly → first instalment, by the instalment invoice's rounding", () => {
    const p = quotePerPeriodFigures({ ...base, cycle: "monthly", lineCommitment: "annual_yearly" });
    expect([p.taxable, p.tax, p.gross, p.cgst + p.sgst]).toEqual([4_050, 729, 4_779, 729]);
    expect(p.yearTotal).toBe(12 * 4_779);
  });

  it("flex → stored figures are one month already (no 12× either way)", () => {
    const p = quotePerPeriodFigures({ subtotal: 8_125, discount: 0, taxable: 8_125, tax: 1_463, total: 9_588, taxRate: 18, cycle: "monthly", lineCommitment: "monthly" });
    expect([p.flex, p.gross, p.plan]).toEqual([true, 9_588, null]);
  });

  it("foreign → no ₹ instalment plan, cents divided by invoices-per-year", () => {
    const p = quotePerPeriodFigures({ subtotal: 600, discount: 0, taxable: 600, tax: 108, total: 708, taxRate: 18, cycle: "quarterly", lineCommitment: "annual_yearly", foreign: true });
    expect([p.plan, p.gross, p.taxable]).toEqual([null, 177, 150]);
  });
});
