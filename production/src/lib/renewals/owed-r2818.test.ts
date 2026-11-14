/**
 * R-2818 (renewals 12-question audit, 14 Nov 2026): Renewals "Previous term unpaid", the row drawer
 * and the follow-up dialog's "Still owes" read ONE owed rule — issued invoices less money in and
 * credit notes, plus a quote's balance not invoiced yet — the customer page's own rule. Never a
 * draft / sent quote, never subscriptions.outstanding_amount alone, never the renewal's price.
 * The three cases are the local E2E Test Co rows the audit found (data read 14 Nov).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { invoiceOwed, priorTermOwed, subscriptionOwed, uninvoicedSubscriptionDue } from "./owed";
import { lastDocsBySubscription, attachDocDetails, priorDueInvoiceGap, shownInvoiceIds, type DocInvoice, type DocQuote, type LastDocsInput } from "@/app/(app)/renewals/last-docs";
import { priorTermOwedOf, priorTermOwedText, subscriptionOwedOf } from "@/app/(app)/renewals/prior-due";
import { lastPaidBySubscription } from "@/app/(app)/renewals/last-paid";
import { drawerPaymentRows, NO_RECEIPT_METHOD } from "@/app/(app)/renewals/drawer";

const TODAY = "2026-11-14";
const q = (over: Partial<DocQuote> & { id: string }): DocQuote => ({
  status: "accepted", payment_status: "invoiced", created_at: "2025-10-01T05:00:00Z", created_date: "2025-10-01",
  expires_date: null, invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null,
  subscription_billing_id: null, superseded_by: null, amount: 11800, currency: "INR", exchange_rate: 1, ...over,
});
const inv = (over: Partial<DocInvoice> & { id: string }): DocInvoice => ({
  quote_id: null, invoice_date: "2025-10-01", status: "pending", amount: 11800, paid_amount: 0, currency: "INR",
  created_at: "2025-10-01T05:00:00Z", due_date: null, ...over,
});
type Sub = LastDocsInput["subs"][number] & { outstanding_amount: number | null; written_off_at?: string | null };
const docsOf = (sub: Sub, over: Partial<LastDocsInput>, opts: { all?: boolean } = {}) => {
  const m = lastDocsBySubscription({ subs: [sub], quotes: [], billings: [], invoices: [], ...over }, opts);
  return attachDocDetails(m, { quotes: [], notes: new Map() }).get(sub.id);
};

describe("R-2818 the owed rule (pure)", () => {
  it("an issued invoice owes net payable less money in; credit notes lower it, debit notes raise it, never below 0", () => {
    expect(invoiceOwed({ id: "I", status: "pending", amount: 100800, paid_amount: 42000 })).toBe(58800);
    expect(invoiceOwed({ id: "I", status: "pending", amount: 11800, paid_amount: 0, credit: 1180 })).toBe(10620);
    expect(invoiceOwed({ id: "I", status: "overdue", amount: 11800, paid_amount: 0, debit: 590 })).toBe(12390);
    expect(invoiceOwed({ id: "I", status: "pending", amount: 11800, paid_amount: 0, credit: 20000 })).toBe(0);
  });

  it("paid, void, draft, cancelled and written-off invoices owe nothing", () => {
    for (const status of ["paid", "void", "draft", "cancelled"]) expect(invoiceOwed({ id: "I", status, amount: 11800, paid_amount: 0 })).toBe(0);
    expect(invoiceOwed({ id: "I", status: "pending", amount: 11800, paid_amount: 0, written_off_at: "2026-11-01" })).toBe(0);
  });

  it("a subscription balance counts only on a quote that has no invoice (the customer Statement's rule)", () => {
    expect(uninvoicedSubscriptionDue({ quote_id: null, outstanding_amount: 25488 }, new Set())).toBe(0);
    expect(uninvoicedSubscriptionDue({ quote_id: "Q-1", outstanding_amount: 28232 }, new Set())).toBe(28232);
    expect(uninvoicedSubscriptionDue({ quote_id: "Q-1", outstanding_amount: 28232 }, new Set(["Q-1"]))).toBe(0);
    expect(uninvoicedSubscriptionDue({ quote_id: "Q-1", outstanding_amount: 28232, written_off_at: "2026-11-01" }, new Set())).toBe(0);
  });

  it("the renewal's own invoice is not 'previous term', but stays in the total; under ₹1 is rounding", () => {
    const all = subscriptionOwed({ quote_id: "Q-OLD", outstanding_amount: 0 }, [
      { id: "INV-OLD", status: "pending", amount: 5000, paid_amount: 0, sourceQuoteId: "Q-OLD" },
      { id: "INV-REN", status: "pending", amount: 11800, paid_amount: 0, sourceQuoteId: "Q-REN" },
    ]);
    expect(all.total).toBe(16800);
    expect(priorTermOwed(all, new Set(["Q-REN"])).total).toBe(5000);
    expect(priorTermOwed(subscriptionOwed({ quote_id: null, outstanding_amount: 0 }, [{ id: "I", status: "pending", amount: 100.5, paid_amount: 100 }]), new Set()).total).toBe(0);
  });
});

describe("R-2818 the audit's three rows, through the real Renewals path", () => {
  it("SCN Kochi: a ₹25,488 balance on no quote or invoice + a DRAFT renewal quote of ₹25,488 → no previous-term debt (customer page: All clear)", () => {
    const sub: Sub = { id: "KOCHI", quote_id: null, renewal_quote_id: "Q-F588-27-0156", start_date: "2025-12-09", outstanding_amount: 25488 };
    const docs = docsOf(sub, { quotes: [q({ id: "Q-F588-27-0156", status: "draft", payment_status: "awaiting", amount: 25488, renewal_subscription_id: "KOCHI" })] });
    expect(subscriptionOwedOf(sub, docs)?.total).toBe(0);
    expect(priorTermOwedText(sub, docs)).toBeNull();
    expect(priorDueInvoiceGap(docs, priorTermOwedOf(sub, docs), TODAY)).toBeNull();
  });

  it("T-V4: original quote on credit, ₹10,000 of ₹38,232 paid, never invoiced → ₹28,232 owed, said against THAT quote (never 'Balance on the subscription')", () => {
    const sub: Sub = { id: "TV4", quote_id: "Q-F588-27-0036", renewal_quote_id: null, start_date: "2026-10-21", outstanding_amount: 28232 };
    const docs = docsOf(sub, {
      quotes: [
        q({ id: "Q-F588-27-0036", payment_status: "partial", amount: 38232 }),
        q({ id: "Q-F588-27-0037", amount: 38232, invoice_id: "INV-F588-27-0017", renewal_subscription_id: "TV4" }),
      ],
      invoices: [inv({ id: "INV-F588-27-0017", quote_id: "Q-F588-27-0037", status: "paid", amount: 38232, paid_amount: 0 })],
    });
    const prior = priorTermOwedOf(sub, docs);
    expect(prior?.total).toBe(28232);
    expect(prior?.notInvoiced).toEqual({ quoteId: "Q-F588-27-0036", due: 28232 });
    expect(priorTermOwedText(sub, docs)).toBe("Previous term ₹28,232 still unpaid");
    const gap = priorDueInvoiceGap(docs, prior, TODAY);
    expect(gap).toBe("Q-F588-27-0036 not invoiced yet");
    expect(gap).not.toMatch(/Balance on the subscription/);
  });

  it("T-V4 after its original quote is invoiced: the invoice is the claim — the balance is never asked twice", () => {
    const sub: Sub = { id: "TV4", quote_id: "Q-0036", renewal_quote_id: null, start_date: "2026-10-21", outstanding_amount: 28232 };
    const docs = docsOf(sub, {
      quotes: [q({ id: "Q-0036", invoice_id: "INV-OLD" })],
      invoices: [inv({ id: "INV-OLD", quote_id: "Q-0036", status: "pending", amount: 38232, paid_amount: 10000 })],
    });
    expect(subscriptionOwedOf(sub, docs)?.total).toBe(28232);
    expect(priorTermOwedOf(sub, docs)?.invoices.map((i) => i.id)).toEqual(["INV-OLD"]);
  });

  it("a part-paid older invoice not on screen is named; the renewal's own unpaid invoice is not 'previous term'", () => {
    const sub: Sub = { id: "S", quote_id: "Q-A", renewal_quote_id: "Q-REN", start_date: "2025-10-01", outstanding_amount: 99999 };
    const docs = docsOf(sub, {
      quotes: [q({ id: "Q-A", invoice_id: "INV-A" }), q({ id: "Q-REN", status: "sent", payment_status: "none", renewal_subscription_id: "S", invoice_id: "INV-REN" })],
      invoices: [
        inv({ id: "INV-A", quote_id: "Q-A", amount: 5000, paid_amount: 2000 }),
        inv({ id: "INV-REN", quote_id: "Q-REN", invoice_date: "2026-11-01", created_at: "2026-11-01T05:00:00Z", amount: 11800 }),
      ],
    });
    expect(subscriptionOwedOf(sub, docs)?.total).toBe(14800);   // follow-up "Still owes": everything on its documents
    expect(priorTermOwedOf(sub, docs)?.total).toBe(3000);        // stored ₹99,999 is never read alone
    expect(shownInvoiceIds(new Map([["S", docs!]]))).toEqual(expect.arrayContaining(["INV-A", "INV-REN"]));
  });

  it("documents not read yet → no amount at all (never a guess from the stored balance)", () => {
    const sub: Sub = { id: "S", quote_id: "Q-A", renewal_quote_id: null, start_date: null, outstanding_amount: 5000 };
    expect(subscriptionOwedOf(sub, undefined)).toBeNull();
    expect(priorTermOwedText(sub, undefined)).toBeNull();
  });

  it("a credit note read for an owed invoice lowers the amount", () => {
    const sub: Sub = { id: "S", quote_id: "Q-A", renewal_quote_id: null, start_date: null, outstanding_amount: 0 };
    const m = lastDocsBySubscription({ subs: [sub], quotes: [q({ id: "Q-A", invoice_id: "INV-A" })], billings: [], invoices: [inv({ id: "INV-A", quote_id: "Q-A" })] });
    const docs = attachDocDetails(m, { quotes: [], notes: new Map([["INV-A", { credit: 1800, debit: 0 }]]) }).get("S");
    expect(subscriptionOwedOf(sub, docs)?.total).toBe(10000);
  });

  it("USD Plan: invoice part paid $500 (₹42,000) with no receipt row → the drawer lists that payment, never 'No payment recorded'", () => {
    const sub: Sub = { id: "USD", quote_id: "Q-CT2737-F", renewal_quote_id: null, start_date: "2025-11-09", outstanding_amount: 0 };
    const docs = docsOf(sub, {
      quotes: [q({ id: "Q-CT2737-F", invoice_id: "INV-CT2737-F", amount: 100800 })],
      invoices: [inv({ id: "INV-CT2737-F", quote_id: "Q-CT2737-F", amount: 100800, paid_amount: 42000, currency: "USD", fx_rate: 84 })],
    }, { all: true });
    const rows = drawerPaymentRows(undefined, docs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: "$500", doc: "INV-CT2737-F", docKind: "invoice", method: NO_RECEIPT_METHOD, date: "" });
    expect(NO_RECEIPT_METHOD).toBe("Paid on the invoice — no receipt in the app");
    expect(subscriptionOwedOf(sub, docs)?.total).toBe(58800);
  });

  it("USD Plan with its $500 receipt recorded → one line, not two", () => {
    const sub: Sub = { id: "USD", quote_id: "Q-F", renewal_quote_id: null, start_date: "2025-11-09", outstanding_amount: 0 };
    const docs = docsOf(sub, {
      quotes: [q({ id: "Q-F", invoice_id: "INV-F" })],
      invoices: [inv({ id: "INV-F", quote_id: "Q-F", amount: 100800, paid_amount: 42000, currency: "USD", fx_rate: 84 })],
    }, { all: true });
    const paid = lastPaidBySubscription({
      subs: [sub], linkedQuotes: [{ id: "Q-F", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: "INV-F" }],
      billings: [], invoices: [{ id: "INV-F", quote_id: "Q-F" }],
      payments: [{ id: "P1", amount: 42000, method: "bank_transfer", status: "received", received_at: "2026-11-01T05:00:00Z", refunded_at: null, quote_id: null, invoice_id: "INV-F" }],
    }, { historySize: Infinity }).get("USD");
    const rows = drawerPaymentRows(paid, docs);
    expect(rows.map((r) => r.id)).toEqual(["P1"]);
  });
});

describe("R-2818 wiring: every screen reads the one rule", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("the rows' flag, the drawer and the follow-up dialog use it; the customer page's not-invoiced step calls the same function", () => {
    const items = read("src/app/(app)/renewals/queue-items.ts");
    expect(items).toMatch(/priorTermUnpaid: priorTermOwedText\(r\.sub, docs\)/);
    expect(items).not.toMatch(/priorTermDueText\(r\.sub\)/);
    const page = read("src/app/(app)/renewals/page.tsx");
    expect(page).not.toMatch(/priorTermDue\(/);
    expect(page).toMatch(/amountDue=\{subscriptionOwedOf\(followupFor\.sub, followupFor\.docs\)\?\.total \?\? 0\}/);
    expect(page).not.toMatch(/amountDue=\{followupFor\.amount\.value\}/);
    const drawer = read("src/app/(app)/renewals/renewal-drawer.tsx");
    expect(drawer).toMatch(/drawerPaymentRows\(q\.data\?\.paid, docs\)/);
    expect(drawer).not.toMatch(/priorTermDue\(/);
    const profile = read("src/components/features/customers/customer-profile.tsx");
    expect(profile).toMatch(/uninvoicedSubscriptionDue\(s, invoicedQuoteIds\)/);
  });
});
