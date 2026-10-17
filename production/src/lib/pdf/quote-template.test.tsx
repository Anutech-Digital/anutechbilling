// @vitest-environment jsdom
/* ─────────────────────────────────────────────────────────────────────────────
   R-1523 — Quote as "Proforma Invoice" + saaf batana ki pay QR kyun nahi aayega.

   PDF ka React tree sach me banta hai (@react-pdf primitives div/span ban kar) aur jo
   chhapa hai wahi padha jaata hai: Proforma par title, "Proforma No." + quote number,
   "not a tax invoice" line, bank details; default Quotation par inme se kuch nahi.
   ───────────────────────────────────────────────────────────────────────────── */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@react-pdf/renderer", () => {
  const strip = ({ children }: { children?: React.ReactNode }) => children;
  const box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const text = ({ children }: { children?: React.ReactNode }) => <span>{children}</span>;
  const link = ({ children, src }: { children?: React.ReactNode; src?: string }) => <a href={src}>{children}</a>;
  return {
    Document: strip, Page: box, View: box, Text: text, Link: link,
    Image: ({ src }: { src?: string }) => <img alt="qr" src={src} />,
    StyleSheet: { create: <T,>(x: T) => x },
    Font: { register: () => {}, registerHyphenationCallback: () => {} },
  };
});

import { QuotePDF, type QuotePDFProps } from "./QuotePDF";
import {
  parseQuoteTemplate, payQrNotice, proformaBank, quoteTemplateFileName,
  PROFORMA_NOTICE, UPI_SETTINGS_HREF,
} from "./quote-template";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

afterEach(cleanup);

const lines = [{ id: "l1", name: "Google Workspace Business Starter", qty: 2, rate: 1000, cost: 900, commitment: "annual_yearly" }] as unknown as QuoteLineItem[];

function pdfText(props: Partial<QuotePDFProps> = {}): string {
  const { container } = render(
    <QuotePDF
      tenantName="Demo Co" quoteId="Q-DEMO-2026-27-0042" customerName="Acme Ltd" validityDays={14}
      createdDate="2026-10-17" expiresDate="2026-10-31"
      lineItems={lines} subtotal={2000} discountPct={0} discount={0} taxable={2000} taxRate={18} tax={360} total={2360}
      interState={false} billingCycle="yearly" termsConditions="50% advance, balance on delivery."
      {...props}
    />,
  );
  return container.textContent ?? "";
}

const BANK = proformaBank({
  name: "Demo Co", remit_bank_name: "HDFC Bank", remit_account_number: "50200012345678",
  remit_ifsc: "HDFC0001234", remit_branch: "Connaught Place",
});

describe("template = proforma", () => {
  it("title Proforma Invoice, quote ka number 'Proforma No.' ke roop me, not-a-tax-invoice line", () => {
    const t = pdfText({ template: "proforma", bank: BANK });
    expect(t).toContain("Proforma Invoice");
    expect(t).toContain("Proforma No.");
    expect(t).toContain("Q-DEMO-2026-27-0042");
    expect(t).toContain(PROFORMA_NOTICE);
    expect(t).not.toMatch(/\bQuotation\b/);
  });

  it("bank details, due date aur terms chhapta hai", () => {
    const t = pdfText({ template: "proforma", bank: BANK });
    expect(t).toContain("HDFC Bank");
    expect(t).toContain("50200012345678");
    expect(t).toContain("HDFC0001234");
    expect(t).toContain("Payment due by this date");
    expect(t).toContain("50% advance, balance on delivery.");
  });

  it("UPI QR tab aata hai jab caller QR deta hai", () => {
    const { container } = render(
      <QuotePDF
        template="proforma" upiQrDataUrl="data:image/png;base64,AAAA" upiVpa="demo@okhdfcbank"
        tenantName="Demo Co" quoteId="Q-1" customerName="Acme" validityDays={14}
        lineItems={lines} subtotal={2000} discountPct={0} discount={0} taxable={2000} taxRate={18} tax={360} total={2360}
        interState={false} billingCycle="yearly"
      />,
    );
    expect(container.querySelector("img[src='data:image/png;base64,AAAA']")).toBeTruthy();
    expect(container.textContent).toContain("demo@okhdfcbank");
  });

  it("pay link PDF me clickable link banta hai", () => {
    const { container } = render(
      <QuotePDF
        template="proforma" payLinkUrl="https://app.example.in/quote/Q-1/accept?t=abc"
        tenantName="Demo Co" quoteId="Q-1" customerName="Acme" validityDays={14}
        lineItems={lines} subtotal={2000} discountPct={0} discount={0} taxable={2000} taxRate={18} tax={360} total={2360}
        interState={false} billingCycle="yearly"
      />,
    );
    expect(container.querySelector("a[href='https://app.example.in/quote/Q-1/accept?t=abc']")).toBeTruthy();
  });
});

describe("paid quote — proforma bhi maange to paise maangne wali koi line nahi", () => {
  it("Valid until / due / pay link / Net-7 / proforma line sab chhupe", () => {
    const { container } = render(
      <QuotePDF
        isPaid template="proforma" bank={BANK} payLinkUrl="https://app.example.in/quote/Q-1/accept?t=abc"
        tenantName="Demo Co" quoteId="Q-1" customerName="Acme" validityDays={14}
        lineItems={lines} subtotal={2000} discountPct={0} discount={0} taxable={2000} taxRate={18} tax={360} total={2360}
        interState={false} billingCycle="yearly"
      />,
    );
    const t = container.textContent ?? "";
    expect(t).toContain("Paid order");
    for (const s of ["Valid until", "Payment due by", "Net 7 days", "Quote validity", "Validity:", "Proforma", PROFORMA_NOTICE, "pay online", "50200012345678"]) {
      expect(t, s).not.toContain(s);
    }
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("default (Quotation) — pehle jaisa", () => {
  it("title Quotation, koi proforma line ya bank block nahi", () => {
    const t = pdfText({ bank: BANK });
    expect(t).toContain("Quotation");
    expect(t).toContain("Q-DEMO-2026-27-0042");
    expect(t).not.toContain("Proforma");
    expect(t).not.toContain(PROFORMA_NOTICE);
    expect(t).not.toContain("50200012345678");
    expect(t).toContain("Valid until");
  });
});

describe("parseQuoteTemplate", () => {
  it("sirf 'proforma' proforma hai; baaki sab Quotation", () => {
    expect(parseQuoteTemplate("proforma")).toBe("proforma");
    expect(parseQuoteTemplate(" Proforma ")).toBe("proforma");
    expect(parseQuoteTemplate(null)).toBe("quotation");
    expect(parseQuoteTemplate("invoice")).toBe("quotation");
    expect(quoteTemplateFileName("proforma", "Q-1")).toBe("Proforma-Q-1.pdf");
    expect(quoteTemplateFileName("quotation", "Q-1")).toBe("Quote-Q-1.pdf");
  });
});

describe("payQrNotice (§24)", () => {
  it("UPI ID nahi → 'Settings me UPI ID daalo' + Settings button", () => {
    const n = payQrNotice({ upiVpa: null, currency: "INR" });
    expect(n?.reason).toBe("no-upi");
    expect(n?.text).toContain("Pay QR ke liye Settings me UPI ID daalo");
    expect(n?.action?.href).toBe(UPI_SETTINGS_HREF);
  });
  it("non-INR → 'UPI sirf INR quotes par', Settings button nahi", () => {
    const n = payQrNotice({ upiVpa: "demo@okhdfcbank", currency: "USD" });
    expect(n?.reason).toBe("non-inr");
    expect(n?.text).toContain("UPI sirf INR quotes par");
    expect(n?.action).toBeUndefined();
  });
  it("UPI set + INR → koi message nahi", () => {
    expect(payQrNotice({ upiVpa: "demo@okhdfcbank", currency: "INR" })).toBeNull();
    expect(payQrNotice({ upiVpa: "demo@okhdfcbank", currency: null })).toBeNull();
  });
  it("proformaBank: account number na ho to null", () => {
    expect(proformaBank({ remit_bank_name: "HDFC" })).toBeNull();
    expect(BANK?.accountName).toBe("Demo Co");
  });
});
