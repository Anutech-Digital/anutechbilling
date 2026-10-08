// @vitest-environment jsdom
/* ─────────────────────────────────────────────────────────────────────────────
   R-212 — ek quote, teen document (preview, email, PDF), EK hi CGST/SGST.

   Pehle teeno apna split khud karte the: preview `Math.round(tax / 2)`, email bhi wahi
   (alag copy), aur PDF `dRound(dTax / 2)`. Foreign quote par PDF float me ulajh jata tha:
   $9.95 / 2 = 4.975 → 497.49999… cents → CGST $4.97, aur extra cent SGST me — jabki
   lib/gst/tax-split ka niyam (odd unit CGST ko) $4.98 + $4.97 deta hai.

   Ab teeno lib/gst/tax-split se. Ye file teeno ko SACH me banati hai (preview DOM me, email
   text, PDF ka React tree — @react-pdf ke primitives ko div/span bana kar) aur jo chhapa hai
   wahi padhti hai.
   ───────────────────────────────────────────────────────────────────────────── */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@react-pdf/renderer", () => {
  const strip = ({ children }: { children?: React.ReactNode }) => children;
  const box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const text = ({ children }: { children?: React.ReactNode }) => <span>{children}</span>;
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

import { QuotePDF, type QuotePDFProps } from "./QuotePDF";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";
import { quoteEmailBody } from "@/lib/email/quote-body";
import { splitIntraStateTax } from "@/lib/gst/tax-split";
import { rupee } from "@/lib/utils";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

afterEach(cleanup);

const line = (qty: number, rate: number) =>
  [{ id: "l1", name: "Google Workspace Business Starter", qty, rate, cost: rate, commitment: "annual_yearly" }] as unknown as QuoteLineItem[];

/** Quote figures exactly as the builder stores them (whole ₹, tax = round(taxable × rate)). */
function quote(qty: number, rate: number) {
  const subtotal = qty * rate;
  const tax = Math.round(subtotal * 0.18);
  return { lineItems: line(qty, rate), subtotal, discountPct: 0, discount: 0, taxable: subtotal, taxRate: 18, tax, total: subtotal + tax };
}

/** "CGST (9%)" label ke bagal wala aankda — jo document par chhapa hai. */
function headFrom(container: HTMLElement, label: string): string {
  const el = Array.from(container.querySelectorAll("span")).find((s) => s.textContent?.trim() === label);
  expect(el, `${label} nahi mila`).toBeTruthy();
  return el!.parentElement!.textContent!.replace(label, "").trim();
}

function pdfHeads(props: Partial<QuotePDFProps> & ReturnType<typeof quote>) {
  const { container } = render(
    <QuotePDF
      tenantName="ANUTECH DIGITAL PVT LTD" quoteId="Q-R212" customerName="Test Co" validityDays={7}
      interState={false} billingCycle="yearly" {...props}
    />,
  );
  return { cgst: headFrom(container, "CGST (9%)"), sgst: headFrom(container, "SGST (9%)") };
}

function previewHeads(props: Partial<React.ComponentProps<typeof QuotePreviewDialog>> & ReturnType<typeof quote>) {
  render(
    <QuotePreviewDialog
      open onOpenChange={() => {}} tenantName="ANUTECH DIGITAL PVT LTD" quoteId="Q-R212" customerName="Test Co"
      interState={false} billingCycle="yearly" validityDays={7} notes="" {...props}
    />,
  );
  return { cgst: headFrom(document.body, "CGST (9%)"), sgst: headFrom(document.body, "SGST (9%)") };
}

function emailHeads(q: ReturnType<typeof quote>) {
  const body = quoteEmailBody({
    quoteId: "Q-R212", customerName: "Test Co",
    supplier: { name: "ANUTECH DIGITAL PVT LTD", gstin: "07ABDCA0298H1ZP", address: "Delhi", state: "Delhi", email: "a@b.in", phone: "1" },
    interState: false, billingCycle: "yearly", createdDate: "2026-10-07", expiresDate: "2026-10-14",
    ...q,
  });
  const pick = (head: string) => body.match(new RegExp(`${head} 9%\\s+(\\S+)`))?.[1];
  return { cgst: pick("CGST"), sgst: pick("SGST") };
}

/** PDF ₹ ko "Rs" likhta hai (font me ₹ nahi) — tulna ke liye ek hi shakl. */
const norm = (s: string | undefined) => (s ?? "").replace(/^Rs\s?/, "₹");

describe("INR quote — odd tax rupee, teeno document same CGST/SGST", () => {
  /* 45 × ₹325 → tax ₹2,633 (odd). 7 × ₹3,240 → ₹4,082.4 → ₹4,082 (even). 1 × ₹1,005 → ₹181. */
  for (const [qty, rate] of [[45, 325], [7, 3240], [1, 1005]] as const) {
    it(`${qty} × ₹${rate}`, () => {
      const q = quote(qty, rate);
      const want = splitIntraStateTax(q.tax);
      const expected = { cgst: rupee(want.cgst), sgst: rupee(want.sgst) };
      expect(want.cgst + want.sgst).toBe(q.tax);

      const p = pdfHeads(q);
      expect({ cgst: norm(p.cgst), sgst: norm(p.sgst) }, "PDF").toEqual(expected);
      cleanup();
      expect(previewHeads(q), "preview").toEqual(expected);
      expect(emailHeads(q), "email").toEqual(expected);
    });
  }
});

describe("foreign quote ka PDF — odd cent CGST ko, float ki galti nahi", () => {
  /* PDF foreign quote ko cents me dobara ginta hai (rate ÷ fx, 2dp). Ye cases naape gaye:
     purana `dRound(dTax / 2)` in par odd cent SGST ko deta tha. */
  const cases: Array<[qty: number, rate: number, fx: number, tax: string, cgst: string, sgst: string]> = [
    [17, 270, 83, "$9.95", "$4.98", "$4.97"],
    [19, 1650, 83, "$67.99", "$34.00", "$33.99"],
    [27, 325, 84, "$18.81", "$9.41", "$9.40"],
    /* Poore dollar ka tax: $3.50 + $3.50 hi — ₹ wala "whole-unit heads" niyam yahan nahi. */
    [10, 325, 83.5, "$7.00", "$3.50", "$3.50"],
  ];
  for (const [qty, rate, fx, tax, cgst, sgst] of cases) {
    it(`${qty} × ₹${rate} @ ${fx} → tax ${tax} = ${cgst} + ${sgst}`, () => {
      const p = pdfHeads({ ...quote(qty, rate), currency: "USD", exchangeRate: fx });
      expect(p).toEqual({ cgst, sgst });
      const cents = (s: string) => Math.round(Number(s.replace(/[$,]/g, "")) * 100);
      expect(cents(p.cgst) + cents(p.sgst)).toBe(cents(tax));
      const viaHelper = splitIntraStateTax(cents(tax));
      expect([viaHelper.cgst, viaHelper.sgst]).toEqual([cents(cgst), cents(sgst)]);
    });
  }
});
