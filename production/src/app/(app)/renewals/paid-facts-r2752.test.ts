/**
 * R-2752 (user audit 14 Nov 2026): on one Renewals row the paid facts must agree.
 *   Greentin Behind 2095 — "Last paid — never paid in the app" next to "Invoice INV-F588-27-0060 · Paid":
 *     the UPI receipt was recorded on the billed part's proforma (quotes.subscription_billing_id),
 *     which Last paid did not link. Now it does; and an invoice marked Paid with no receipt at all
 *     reads "Paid, no receipt in the app", never "never paid".
 *   SCN Ads Gamma Studio — "Previous term ₹98 still unpaid" next to a Paid invoice: the ₹98 is only
 *     on subscriptions.outstanding_amount → "Balance on the subscription, no invoice — not in the
 *     customer's statement" (why the customer page says All clear).
 *   SCN Kochi Hosting — ₹25,488 with no invoice at all → the same words.
 *   Under ₹1 is paise rounding, never "still unpaid".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lastPaidBySubscription, paidNoReceipt } from "./last-paid";
import { lastDocsBySubscription, paidInvoiceOf, priorDueInvoiceGap, type DocInvoice, type DocQuote } from "./last-docs";
import { priorTermDue, priorTermDueText } from "./prior-due";

const TODAY = "2026-11-14";
const GAP = "Balance on the subscription — no unpaid invoice linked to it";

describe("R-2752 Greentin shape — a receipt on the billed part's proforma is this subscription's Last paid", () => {
  const SUB = "5ab00000-2095-0000-0000-000000000011";
  it("payment on PI (subscription_billing_id → the billing row) links through the part; the line names the part's invoice", () => {
    const m = lastPaidBySubscription({
      subs: [{ id: SUB, quote_id: null, renewal_quote_id: null }],
      linkedQuotes: [{ id: "Q-F588-27-0062", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: "INV-F588-27-0060", subscription_billing_id: "bill-1" }],
      billings: [{ id: "bill-1", subscription_id: SUB, invoice_id: "INV-F588-27-0060" }, { id: "bill-2", subscription_id: SUB, invoice_id: null }],
      invoices: [],
      payments: [{ id: "pay-1", amount: 3835, method: "upi", status: "received", received_at: "2026-10-12T05:00:00Z", refunded_at: null, quote_id: "Q-F588-27-0062", invoice_id: null }],
    });
    const lp = m.get(SUB)!;
    expect(lp.last.paymentId).toBe("pay-1");
    expect(lp.last.invoiceId).toBe("INV-F588-27-0060");
    expect(lp.last.covers).toBe(1);
  });
  it("a part proforma of ANOTHER subscription's billing row never counts", () => {
    const m = lastPaidBySubscription({
      subs: [{ id: SUB, quote_id: null, renewal_quote_id: null }],
      linkedQuotes: [{ id: "PI-X", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: null, subscription_billing_id: "bill-other" }],
      billings: [{ id: "bill-1", subscription_id: SUB, invoice_id: null }],
      invoices: [],
      payments: [{ id: "pay-x", amount: 100, method: "upi", status: "received", received_at: "2026-10-12T05:00:00Z", refunded_at: null, quote_id: "PI-X", invoice_id: null }],
    });
    expect(m.get(SUB)).toBeUndefined();
  });
  it("no receipt at all but the row's invoice reads Paid → that invoice, 'Paid, no receipt in the app'", () => {
    const SUB2 = "c2752000-0000-4000-8000-0000000000a1";
    const q: DocQuote = { id: "Q-1", status: "accepted", payment_status: "received", created_at: "2026-10-01T05:00:00Z", created_date: "2026-10-01", expires_date: null, invoice_id: "INV-1", renewal_subscription_id: null, add_seats_subscription_id: null, subscription_billing_id: null, superseded_by: null };
    const i: DocInvoice = { id: "INV-1", quote_id: "Q-1", invoice_date: "2026-10-01", status: "paid", amount: 3835, paid_amount: 3835, currency: "INR", created_at: "2026-10-01T05:00:00Z", due_date: null };
    const docs = lastDocsBySubscription({ subs: [{ id: SUB2, quote_id: "Q-1", renewal_quote_id: null, start_date: "2026-10-01" }], quotes: [q], billings: [], invoices: [i] }).get(SUB2);
    expect(paidInvoiceOf(docs, TODAY)).toEqual({ id: "INV-1", words: "Paid" });
    expect(paidInvoiceOf(undefined, TODAY)).toBeNull();
    const unpaid = lastDocsBySubscription({ subs: [{ id: SUB2, quote_id: "Q-1", renewal_quote_id: null, start_date: "2026-10-01" }], quotes: [q], billings: [], invoices: [{ ...i, status: "pending", paid_amount: 0 }] }).get(SUB2);
    expect(paidInvoiceOf(unpaid, TODAY)).toBeNull();
    expect(paidNoReceipt("Paid")).toBe("— Paid, no receipt in the app");
    /* review: settled by advance (nothing left, not marked paid) is settled too — its own words */
    const advance = lastDocsBySubscription({ subs: [{ id: SUB2, quote_id: "Q-1", renewal_quote_id: null, start_date: "2026-10-01" }], quotes: [q], billings: [], invoices: [{ ...i, status: "pending", paid_amount: 0, net_payable: 0, adjusted_advances: [{ amount: 3835 }] }] }).get(SUB2);
    expect(paidInvoiceOf(advance, TODAY)).toEqual({ id: "INV-1", words: "Covered by advance" });
  });
});

describe("R-2752 SCN Ads / SCN Kochi shapes — 'Previous term' says where the balance is", () => {
  it("₹98 on the subscription, its invoice Paid (shown on the row) → the balance words, true next to a Paid invoice", () => {
    const paidInv = { id: "SCN-ADS-INV3", date: "2026-11-01", status: "paid", amount: 1180, paidAmount: 1180, currency: "INR", dueDate: null, netPayable: null, adjustedAdvances: null, writtenOffAt: null, fxRate: null, sourceQuoteId: null, part: null, period: null, notes: undefined };
    const docs = { quote: null, sent: null, invoice: paidInv, invoices: [paidInv] };
    expect(priorTermDueText({ outstanding_amount: 98, written_off_at: null })).toBe("Previous term ₹98 still unpaid");
    expect(priorDueInvoiceGap(docs, 98, TODAY)).toBe(GAP);
  });
  it("₹25,488 with no invoice at all → the same words", () => {
    expect(priorDueInvoiceGap(undefined, 25488, TODAY)).toBe(GAP);
  });
  it("under ₹1 is paise rounding — never 'still unpaid'", () => {
    expect(priorTermDue({ outstanding_amount: 0.4, written_off_at: null })).toBe(0);
    expect(priorTermDueText({ outstanding_amount: 0.99, written_off_at: null })).toBeNull();
    expect(priorTermDue({ outstanding_amount: 1, written_off_at: null })).toBe(1);
  });
});

describe("R-2752 wiring", () => {
  const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
  const data = readFileSync("src/app/(app)/renewals/last-paid-data.ts", "utf8");
  it("the row's Last paid gets the row's Paid invoice, and waits for the docs before saying 'never paid'", () => {
    expect(page).toMatch(/paidInvoice=\{paidInvoiceOf\(item\.docs, todayIst\)\}/);
    expect(page).toMatch(/loading=\{lastPaid\.loading \|\| \(!paid && docsState\.loading\)\}/);
    /* review: docs failed → "couldn't load", never a false "never paid" */
    expect(page).toMatch(/failed=\{lastPaid\.failed \|\| \(!paid && docsState\.failed\)\}/);
  });
  it("Last paid reads the billed parts' proformas in the same batched round (no per-row read)", () => {
    /* R-2765 (changed expectation): the proformas come from Last docs' shared rounds 1–2 (one read for
       both) — data-reads-r2765.test.ts proves a part-proforma payment still counts. */
    const docs = readFileSync("src/app/(app)/renewals/last-docs-data.ts", "utf8");
    expect(docs).toMatch(/\.in\("subscription_billing_id", run\)/);
    expect(data).toMatch(/docRows\.parts\.map\(\(q\) => \(\{ id: q\.id, invoice_id: q\.invoice_id \?\? null, subscription_billing_id: q\.subscription_billing_id \?\? null/);
    expect(data).not.toMatch(/\.single\(\)|\.maybeSingle\(\)/);
  });
});
