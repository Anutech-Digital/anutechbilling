// @vitest-environment jsdom
/**
 * R-2580 (follow-up of R-2193) — a Monthly flex sale with a one-time line (domain / setup).
 *
 * R-2193 lets one sale carry 10 × ₹264 flex seats + a ₹1,200 domain: stored subtotal ₹3,840,
 * total ₹4,531 incl 18% GST — that is MONTH 1. Month 2 on bills the seats only (the domain is
 * billed once, quote_one_time_lines). The preview and the PDF printed the whole ₹4,531 as
 * "/month" and the preview's "Annual contract value" as ₹54,372/yr (₹4,531 × 12); the domain
 * line read "₹1,200/month". With the domain typed first the PDF even read the quote as an
 * annual one and divided by 12.
 */
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

import { flexOneTimeFigures } from "./per-period-figures";
import { QuotePDF } from "@/lib/pdf/QuotePDF";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";
import { quoteDueNow } from "@/lib/payments/quote-due-now";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

afterEach(cleanup);

const SEATS = { id: "s", name: "Google Workspace Business Starter", qty: 10, rate: 264, cost: 200, commitment: "monthly" } as QuoteLineItem;
const DOMAIN = { id: "d", name: "Domain flex2580.in", qty: 1, rate: 1200, cost: 900, one_time: true } as QuoteLineItem;

const docProps = (lineItems: QuoteLineItem[]) => ({
  tenantName: "E2E Test Co", quoteId: "Q-R2580", customerName: "Flex Buyer",
  lineItems, subtotal: 3840, discountPct: 0, discount: 0, taxable: 3840, taxRate: 18, tax: 691, total: 4531,
  interState: false, billingCycle: "monthly" as const, validityDays: 7,
});

/** Text next to a label in a rendered document. */
function valueFor(container: HTMLElement, label: string): string {
  const el = Array.from(container.querySelectorAll("span")).find((s) => s.textContent?.trim() === label);
  expect(el, `${label} not found`).toBeTruthy();
  return el!.parentElement!.textContent!.replace(label, "").trim().replace(/^Rs\s?/, "₹").replace(/\s+/g, " ");
}

describe("R-2580: the figures", () => {
  it("₹3,115 a month for the seats; the domain ₹1,416 once (incl GST)", () => {
    const f = flexOneTimeFigures({ lines: [SEATS, DOMAIN], discountPct: 0, subtotal: 3840, taxable: 3840, total: 4531, taxRate: 18 })!;
    expect(f.monthly).toEqual({ subtotal: 2640, discount: 0, taxable: 2640, tax: 475, gross: 3115 });
    expect(f.once).toEqual({ taxable: 1200, tax: 216, gross: 1416 });
  });

  it("same answer with the domain typed first", () => {
    const f = flexOneTimeFigures({ lines: [DOMAIN, SEATS], discountPct: 0, subtotal: 3840, taxable: 3840, total: 4531, taxRate: 18 })!;
    expect(f.monthly.gross).toBe(3115);
    expect(f.once.gross).toBe(1416);
  });

  it("a discount is shared the way quote_one_time_lines bills it", () => {
    // 10% off: taxable 3,456; domain 1,080 once; seats 2,376 + 428 GST = 2,804 a month.
    const f = flexOneTimeFigures({ lines: [SEATS, DOMAIN], discountPct: 10, subtotal: 3840, taxable: 3456, total: 4078, taxRate: 18 })!;
    expect(f.monthly).toEqual({ subtotal: 2640, discount: 264, taxable: 2376, tax: 428, gross: 2804 });
    expect(f.once.taxable).toBe(1080);
    expect(f.monthly.gross + f.once.gross).toBe(4078);
  });

  it("nothing to split: flex only, annual + one-time, one-time only", () => {
    const base = { discountPct: 0, subtotal: 2640, taxable: 2640, total: 3115, taxRate: 18 };
    expect(flexOneTimeFigures({ ...base, lines: [SEATS] })).toBeNull();
    expect(flexOneTimeFigures({ ...base, lines: [{ ...SEATS, commitment: "annual_yearly" }, DOMAIN] })).toBeNull();
    expect(flexOneTimeFigures({ ...base, lines: [DOMAIN] })).toBeNull();
  });
});

describe("R-2580: the quote PDF", () => {
  for (const order of [[SEATS, DOMAIN], [DOMAIN, SEATS]]) {
    it(`month 1 ₹4,531, then ₹3,115/mo, domain once (${order[0].id === "d" ? "domain first" : "seats first"})`, () => {
      const { container } = render(<QuotePDF {...docProps(order)} />);
      const text = container.textContent!.replace(/Rs\s?/g, "₹");
      expect(valueFor(container, "First invoice (incl. one-time)")).toBe("₹4,531");
      expect(valueFor(container, "Then each month")).toBe("₹3,115/mo");
      expect(valueFor(container, "One-time, billed once with the first invoice")).toBe("₹1,416");
      expect(text).not.toContain("₹4,531/mo");
      expect(text).not.toContain("₹1,200/mo");
      expect(text).not.toContain("₹100/mo");
      expect(text).not.toMatch(/54,372|Annual contract value/);
    });
  }

  it("a flex quote with no one-time line prints as before", () => {
    const { container } = render(<QuotePDF {...docProps([SEATS])} subtotal={2640} taxable={2640} tax={475} total={3115} />);
    expect(valueFor(container, "Per invoice")).toBe("₹3,115/mo");
  });
});

describe("R-2580: the staff preview", () => {
  for (const order of [[SEATS, DOMAIN], [DOMAIN, SEATS]]) {
    it(`same words as the PDF (${order[0].id === "d" ? "domain first" : "seats first"})`, () => {
      render(<QuotePreviewDialog open onOpenChange={() => {}} notes="" {...docProps(order)} />);
      const body = document.body;
      expect(valueFor(body, "First invoice (incl. one-time)")).toBe("₹4,531");
      expect(valueFor(body, "Then each month")).toBe("₹3,115/mo");
      expect(valueFor(body, "One-time, billed once with the first invoice")).toBe("₹1,416");
      expect(body.textContent).not.toContain("₹4,531/mo");
      expect(body.textContent).not.toContain("₹1,200/mo");
      expect(body.textContent).not.toContain("₹100/mo");
      expect(body.textContent).not.toMatch(/54,372|Annual contract value/);
      expect(body.textContent).toContain("₹2,640/mo"); // the seats line, a month
    });
  }
});

describe("R-2580: what the customer pays now", () => {
  it("month 1 in full (seats + domain), never 1/12 of it — whichever line comes first", () => {
    for (const order of [[SEATS, DOMAIN], [DOMAIN, SEATS]]) {
      const due = quoteDueNow({ amount: 4531, subtotal: 3840, discount_pct: 0, tax_rate: 18, billing_cycle: "monthly", line_items: order }, 0);
      expect(due).toMatchObject({ state: "due", amount: 4531, instalment: null });
    }
  });
});
