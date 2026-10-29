// @vitest-environment jsdom
/**
 * R-2093 — a support-plan upgrade quote says "Upgrade" on EVERY customer-facing path.
 *
 * R-2087 fixed the quote page and the server PDF (build-props), but the email PDF, the
 * WhatsApp PDF, the attachment builder, the auto-quote mail, the renewal reminders and the
 * /quote/[id]/accept page each passed their own `isRenewal: quote.is_renewal` — so the
 * customer still read "Renewal Quotation". Every path now asks quoteDocumentKind (one
 * helper, isSupportUpgradeQuote first). The partial-payment toast said "renewal" too.
 */
import * as React from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/razorpay/checkout-client", () => ({ loadRazorpayCheckout: vi.fn() }));

import {
  flagsForQuoteKind, quoteDocumentKind, quoteDocumentLabel, quoteKindFlags,
} from "./quote-document-kind";
import { paymentToast, type PaymentToastInput } from "@/lib/payments/record-payment-toast";
import { createOrGetRenewalQuote } from "@/lib/renewals/create-renewal-quote";
import { QuoteAcceptView, type PublicQuote } from "@/app/(public)/quote/[id]/accept/quote-accept-view";

afterEach(cleanup);

/* The shape buildSupportUpgrade saves (R-2073): renewal-linked, buys no time, SUP line. */
const upgrade = {
  is_renewal: true, is_extension: false, extension_months: 0,
  line_items: [{ item_id: "SUP-ENT-Y", name: "Enterprise support · upgrade from Standard" }],
};
const renewal = { ...upgrade, extension_months: 12, line_items: [{ item_id: "GWS-BS", name: "Business Starter" }] };
const plain = { is_renewal: false, is_extension: false, extension_months: null, line_items: [{ item_id: "GWS-BS" }] };

describe("quoteDocumentKind — one answer", () => {
  it("upgrade / renewal / quote", () => {
    expect(quoteDocumentKind(upgrade)).toBe("upgrade");
    expect(quoteDocumentKind(renewal)).toBe("renewal");
    expect(quoteDocumentKind(plain)).toBe("quote");
    /* A support RENEWAL (months > 0) is still a renewal. */
    expect(quoteDocumentKind({ ...upgrade, extension_months: 12 })).toBe("renewal");
  });
  it("flags fed to QuotePDF / RecordPaymentDialog", () => {
    expect(quoteKindFlags(upgrade)).toEqual({ isRenewal: true, isUpgrade: true });
    expect(quoteKindFlags(renewal)).toEqual({ isRenewal: true, isUpgrade: false });
    expect(flagsForQuoteKind("quote")).toEqual({ isRenewal: false, isUpgrade: false });
  });
  it("the PDF heading is 'Upgrade Quotation' for the upgrade quote", () => {
    expect(quoteDocumentLabel({ paid: false, ...quoteKindFlags(upgrade) })).toBe("Upgrade Quotation");
    expect(quoteDocumentLabel({ paid: false, ...quoteKindFlags(renewal) })).toBe("Renewal Quotation");
    expect(quoteDocumentLabel({ paid: false, ...quoteKindFlags(plain) })).toBe("Quotation");
  });
});

/* Every renderer that builds QuotePDF / the record-payment sheet itself must take its flags
   from the helper — never `isRenewal: quote.is_renewal` (the R-2093 defect). */
const SRC = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
const PATHS: [string, string][] = [
  ["email PDF (Send quote)",          "app/api/quotes/[id]/send/route.ts"],
  ["WhatsApp PDF",                    "app/api/whatsapp/send/route.ts"],
  ["PDF attachment builder",          "lib/quotes/quote-pdf-attachment.ts"],
  ["auto-quote mail PDF",             "lib/quotes/send-auto-quote.ts"],
  ["server PDF (download / v1 API)",  "lib/pdf/build-props.ts"],
  ["quote page client PDF + sheet",   "app/(app)/quotes/[id]/page.tsx"],
  ["accept page",                     "app/(public)/quote/[id]/accept/page.tsx"],
  ["quote action bar sheet",          "components/features/quotes/quote-action-bar.tsx"],
  ["payments page sheet",             "app/(app)/payments/record-quote-payment.tsx"],
];

describe("every customer-facing path asks the helper", () => {
  it.each(PATHS)("%s", (_label, rel) => {
    const src = read(rel);
    expect(src).toMatch(/quoteKindFlags\(quote\)/);
    /* The sheet prop never reads the raw flag. */
    expect(src).not.toMatch(/isRenewal=\{!*quote\.is_renewal\}/);
    /* Nor does any PDF props object. (quoteServicePeriod / orphanState still take
       is_renewal: the upgrade line is dated, and "no new subscription" holds for it.) */
    for (const call of src.split(/renderQuotePDF\(|QuotePDFProps \{|const pdfProps/).slice(1)) {
      expect(call.slice(0, 4000)).not.toMatch(/isRenewal:\s*quote\.is_renewal/);
    }
  });
  it.each([
    ["renewal reminder (Send now)", "app/api/renewals/send-now/route.ts"],
    ["renewal reminder (cron)",     "app/api/cron/renewals/route.ts"],
  ])("%s takes the linked quote's kind, not a fixed renewal", (_label, rel) => {
    const src = read(rel);
    expect(src).toMatch(/flagsForQuoteKind\(/);
    expect(src).not.toMatch(/^\s*isRenewal:\s*true,/m);
  });
});

describe("renewal reminder: the subscription's linked quote may be an upgrade", () => {
  it("createOrGetRenewalQuote reports kind 'upgrade' for a linked upgrade quote", async () => {
    const row = { id: "Q-1", amount: 1180, subtotal: 1000, discount_pct: 0, tax_rate: 18, ...upgrade };
    const select = vi.fn(() => ({ eq: () => ({ single: async () => ({ data: row, error: null }) }) }));
    const supabase = { from: () => ({ select }) };
    const r = await createOrGetRenewalQuote({
      supabase: supabase as never, subscriptionId: "s", tenantId: "t", customerId: null, customerName: "C",
      plan: "p", itemId: null, seats: 1, mrr: 0, termMonths: 12, renewalDate: "2027-01-01", graceDays: 0,
      existingQuoteId: "Q-1",
    } as never);
    expect(r?.kind).toBe("upgrade");
    expect(String((select.mock.calls[0] as unknown[])[0])).toMatch(/is_renewal, is_extension, extension_months/);
  });
});

describe("accept page heading", () => {
  const pq = (over: Partial<PublicQuote> = {}): PublicQuote => ({
    id: "Q-1", status: "sent", customer_name: "Test Co", subtotal: 1000, discount_pct: 0,
    tax_rate: 18, amount: 1180, expires_date: null, notes: null, billing_cycle: "yearly",
    currency: "INR", exchange_rate: null, ...over,
  });
  const view = (quote: PublicQuote) => render(
    <QuoteAcceptView quote={quote} lineItems={[]} token="t" tenantName="ACME" tenantGstin={null} tenantEmail={null} />,
  );
  it("upgrade quote reads 'Upgrade Quotation'", () => {
    view(pq({ document_label: quoteDocumentLabel({ paid: false, ...quoteKindFlags(upgrade) }) }));
    expect(screen.getByTestId("document-label").textContent).toBe("Upgrade Quotation");
  });
  it("no label → plain 'Quotation'", () => {
    view(pq());
    expect(screen.getByTestId("document-label").textContent).toBe("Quotation");
  });
});

describe("record-payment toast", () => {
  const base: PaymentToastInput = {
    outstanding: 500, isFullyPaid: false, convertedNow: false, subscriptionCreated: false,
    invoicePaid: false, hasExistingInvoice: false, isRenewalQuote: true, renewalRolledForward: false,
    overpaidCredit: 0, tdsRecorded: false, tdsAttempted: false, tdsAmount: 0, paymentId: null,
    receiptVoucherNo: null, customerName: "C", invoiceId: null, subscriptionNote: null, receiptUploadFailed: false,
  };
  it("partial payment on an upgrade quote says upgrade, never renewal", () => {
    const t = paymentToast({ ...base, isUpgradeQuote: true });
    expect(t.title).toMatch(/^Partial upgrade payment recorded · .*500.* still due to upgrade the plan$/);
    expect([t.title, ...t.lines].join(" ")).not.toMatch(/renew/i);
  });
  it("full payment on an upgrade quote says the plan is upgraded", () => {
    expect(paymentToast({ ...base, isUpgradeQuote: true, isFullyPaid: true, outstanding: 0 }).title)
      .toBe("Paid in full · support plan upgraded");
  });
  it("a real renewal keeps its wording", () => {
    expect(paymentToast(base).title).toMatch(/^Partial renewal payment recorded/);
  });
});
