/* R-1715 (billing audit, 20 Oct) + R-1680 (staging release check, 19 Oct) — small words on the
   billing screens that said something untrue. Each one is fixed where the word is made:
     ("This quote is paid" on unpaid T-L3 was fixed by R-1689 — provisioning-card setupLine.)
     - workflow-history times read from updated_at, so they moved on every edit (Q-0030)
     - "GST e-invoice ready" with no IRP connected
     - "BANK_TRANSFER" / "Bank_transfer" — the stored method shown raw
     - "₹1,006/yr" and "Ext · 0yr" on one-time pro-rata / month-extension quotes
     - "Money received ₹25,000" on Payment Follow-up = only the follow-up customers' money
     - the payment sheet said "Issues a GST receipt voucher" AND "No new receipt voucher"
     - the customer statement printed "₹-5,000" for money the customer has in credit
     - the invoice page had no "Balance due" line
     - the customer page kept old numbers after a payment until a reload */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { paymentMethodLabel } from "@/lib/payments/method-label";
import { extensionBadgeLabel } from "./billing";
import { quoteRowTotalPeriods } from "./per-period-figures";
import { historyTime } from "./history-time";
import { recordPaymentConsequences } from "@/lib/payments/record-consequences";
import { statementBalanceText } from "@/components/features/customers/customer-statement";
import { RECEIVABLE_KEYS } from "@/lib/queries/receivables-refresh";

const SRC = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

describe("payment method — one label map", () => {
  it("stored values read as words", () => {
    expect(paymentMethodLabel("BANK_TRANSFER")).toBe("Bank transfer");
    expect(paymentMethodLabel("bank_transfer")).toBe("Bank transfer");
    expect(paymentMethodLabel("upi")).toBe("UPI");
    expect(paymentMethodLabel(null)).toBe("—");
  });

  it("no billing screen prints the raw stored method", () => {
    const files = [
      "app/(app)/quotes/[id]/page.tsx",
      "app/(app)/invoices/invoice-detail.tsx",
      "app/(app)/invoices/opening-invoice-detail.tsx",
      "app/(app)/invoices/page.tsx",
      "components/features/quotes/receipt-voucher-dialog.tsx",
      "components/features/quotes/tax-invoice-dialog.tsx",
      "lib/pdf/InvoicePDF.tsx",
      "lib/pdf/ReceiptVoucherPDF.tsx",
    ];
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/\.method\??\.(replace|toUpperCase)\(/);
      expect(src, f).not.toMatch(/\{\s*p\.method\s*(\?\?[^}]*)?\}/);
      expect(src, f).not.toMatch(/method \?\? "[a-z]+"\)\.replace\(/);
    }
  });
});

describe("history times come from the stored event, never updated_at", () => {
  it("a fixed IST format", () => {
    expect(historyTime("2026-10-20T09:17:00Z")).toBe(historyTime("2026-10-20T09:17:00.000Z"));
    expect(historyTime(null)).toBe("—");
  });

  it("the quote page's history never reads quote.updated_at", () => {
    expect(read("app/(app)/quotes/[id]/page.tsx")).not.toMatch(/historyTime\([^)]*updated_at/);
  });

  it("no 'e-invoice ready' without an IRP", () => {
    expect(read("app/(app)/quotes/[id]/page.tsx")).not.toMatch(/e-invoice ready/i);
  });
});

describe("no '/yr' on a one-time charge", () => {
  it("add-seats, one-off and month-extension totals carry no period", () => {
    /* R-2222: the /quotes list now reads quoteRowTotalPeriods (one helper with the quote page). */
    const unit = (q: Record<string, unknown>) =>
      quoteRowTotalPeriods({ amount: 1006, subtotal: 853, tax_rate: 18, ...q })?.unit ?? null;
    expect(unit({ billing_cycle: "yearly", is_add_seats: true })).toBe(null);
    expect(unit({ billing_cycle: "yearly", is_one_off: true })).toBe(null);
    expect(unit({ billing_cycle: "yearly", is_extension: true, extension_months: 3 })).toBe(null);
    expect(unit({ billing_cycle: "yearly" })).toBe("year");
    expect(unit({ billing_cycle: "monthly", line_items: [{ commitment: "monthly" }] })).toBe("month");
    expect(unit({ billing_cycle: null })).toBe(null);
  });

  it("an extension badge says its months (was 'Ext · 0yr' for 3 months)", () => {
    expect(extensionBadgeLabel(3)).toBe("Ext · 3 months");
    expect(extensionBadgeLabel(1)).toBe("Ext · 1 month");
    expect(extensionBadgeLabel(12)).toBe("Ext · 1 yr");
    expect(extensionBadgeLabel(24)).toBe("Ext · 2 yr");
    expect(extensionBadgeLabel(18)).toBe("Ext · 18 months");
    expect(extensionBadgeLabel(null)).toBe("Ext · 1 yr");
  });
});

describe("Payment Follow-up tile says whose money it counts", () => {
  it("not 'Money received' — only the follow-up list's customers", () => {
    const src = read("components/features/collections/owner-report.tsx");
    expect(src).not.toMatch(/label="Money received"/);
    expect(src).toMatch(/Received from follow-up list/);
  });
});

describe("R-1680 the payment sheet never says two opposite things", () => {
  const payment = {
    quoteId: "Q-1", customerName: "T-A1", amount: 5000, quoteAmount: 38232, priorReceived: 0,
    createsCustomer: false, createsSubscription: true, planLabel: "Workspace",
  };

  it("after the invoice: no receipt voucher line", () => {
    const out = recordPaymentConsequences({ payment, receiptSeries: null, afterInvoice: true }).map((c) => c.text).join("\n");
    expect(out).not.toMatch(/Issues .*receipt voucher/);
    expect(out).toMatch(/No receipt voucher/);
  });

  it("before the invoice, the first of the year still says it issues one", () => {
    const out = recordPaymentConsequences({ payment, receiptSeries: null }).map((c) => c.text).join("\n");
    expect(out).toMatch(/Issues a GST receipt voucher/);
  });
});

describe("R-1680 a credit balance is written as credit, never ₹-5,000", () => {
  it("statement balance", () => {
    expect(statementBalanceText(-5000)).toBe("₹5,000 credit");
    expect(statementBalanceText(5000)).toBe("₹5,000");
    expect(statementBalanceText(0)).toBe("₹0");
  });

  it("the statement table uses it", () => {
    expect(read("components/features/customers/customer-profile.tsx")).toMatch(/statementBalanceText\(e\.balance\)/);
  });
});

describe("R-1680 the invoice page shows Balance due", () => {
  it("next to the total", () => {
    expect(read("app/(app)/invoices/invoice-detail.tsx")).toMatch(/Balance due/);
  });
});

describe("R-1680 the customer page refreshes after money moves", () => {
  it("credit notes and project money are refreshed with every balance screen", () => {
    const keys = RECEIVABLE_KEYS.map((k) => k[0]);
    expect(keys).toContain("credit-notes");
    expect(keys).toContain("project_payments");
    expect(keys).toContain("project_sales");
  });
});
