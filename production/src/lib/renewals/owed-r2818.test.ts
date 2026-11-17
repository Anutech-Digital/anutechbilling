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
import { subscriptionReceivable } from "@/lib/payments/receivables";
import { renewalRisk, topRiskReasons } from "@/app/(app)/renewals/risk";
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
  it("an issued invoice owes net payable less money in", () => {
    expect(invoiceOwed({ id: "I", status: "pending", amount: 100800, paid_amount: 42000 })).toBe(58800);
  });

  /* review rev-r2818 #1 (HIGH): the credit / debit note RPCs already move invoices.net_payable (and a
     debit note re-opens a Paid invoice with paid_amount = the old net) — migration r2717 :269-270,
     :382-405. Fixtures in that REAL shape; the notes must never be applied a second time. */
  it("notes are already inside net_payable (the RPCs move it) — never counted twice", () => {
    /* unpaid ₹10,000 + ₹2,000 credit note → net_payable 8,000 → owes 8,000 (not 6,000) */
    expect(invoiceOwed({ id: "I", status: "pending", amount: 10000, net_payable: 8000, paid_amount: 0 })).toBe(8000);
    /* paid ₹10,000 + ₹1,000 debit note → Pending, net 11,000, paid_amount 10,000 → owes 1,000 (not 2,000) */
    expect(invoiceOwed({ id: "I", status: "pending", amount: 10000, net_payable: 11000, paid_amount: 10000 })).toBe(1000);
    /* credit note for more than is left → net 0 → nothing */
    expect(invoiceOwed({ id: "I", status: "pending", amount: 10000, net_payable: 0, paid_amount: 0 })).toBe(0);
    /* the same through the row's documents (notes read for the status words) */
    const sub: Sub = { id: "S", quote_id: "Q-A", renewal_quote_id: null, start_date: null, outstanding_amount: 0 };
    const m = lastDocsBySubscription({ subs: [sub], quotes: [q({ id: "Q-A", invoice_id: "INV-A" })], billings: [], invoices: [
      inv({ id: "INV-A", quote_id: "Q-A", amount: 10000, net_payable: 8000, paid_amount: 0 }),
    ] });
    const docs = attachDocDetails(m, { quotes: [], notes: new Map([["INV-A", { credit: 2000, debit: 0 }]]) }).get("S");
    expect(subscriptionOwedOf(sub, docs)?.total).toBe(8000);
    const m2 = lastDocsBySubscription({ subs: [sub], quotes: [q({ id: "Q-A", invoice_id: "INV-A" })], billings: [], invoices: [
      inv({ id: "INV-A", quote_id: "Q-A", status: "pending", amount: 10000, net_payable: 11000, paid_amount: 10000 }),
    ] });
    const docs2 = attachDocDetails(m2, { quotes: [], notes: new Map([["INV-A", { credit: 0, debit: 1000 }]]) }).get("S");
    expect(subscriptionOwedOf(sub, docs2)?.total).toBe(1000);
  });

  it("the customer page's not-invoiced step gives the same number as before for every shape (only routed through the shared function)", () => {
    const before = (s: { quote_id: string | null; outstanding_amount: number | null; written_off_at?: string | null }, ids: ReadonlySet<string>) => {
      const due = subscriptionReceivable(s, ids);
      return due > 0 && s.quote_id ? due : 0;
    };
    const quoteIds = [null, "Q-1"];
    const amounts = [null, -50, 0, 0.4, 1, 98, 25488, 28232.6];
    const offs = [null, "2026-11-01"];
    const sets = [new Set<string>(), new Set(["Q-1"]), new Set(["Q-2"])];
    for (const quote_id of quoteIds) for (const outstanding_amount of amounts) for (const written_off_at of offs) for (const ids of sets) {
      const s = { quote_id, outstanding_amount, written_off_at };
      expect(uninvoicedSubscriptionDue(s, ids), JSON.stringify({ s, ids: [...ids] })).toBe(before(s, ids));
    }
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

  /* review rev-r2818 #3: after "Bill next part" the renewal's own part proforma is invoiced — that unpaid
     part invoice is this renewal's money, not "Previous term"; a part of the FIRST term (the original
     sale, R-2740's shape) still is. Still owed in total (follow-up "Still owes"). */
  it("the newest (renewal) term's billed part invoices are not 'previous term'; the first term's parts are", () => {
    const bill = (over: Record<string, unknown>) => ({ subscription_id: "S", invoice_id: null, term_start: "2025-12-01", period_index: 1, period_start: null, period_end: null, ...over });
    const sub: Sub = { id: "S", quote_id: "Q-A", renewal_quote_id: null, start_date: "2025-12-01", outstanding_amount: 0 };
    const docs = docsOf(sub, {
      quotes: [
        q({ id: "Q-A", invoice_id: "INV-A" }),
        q({ id: "PI-OLD", subscription_billing_id: "B-OLD", invoice_id: "INV-OLD" }),
        q({ id: "PI-NEW", subscription_billing_id: "B-NEW", invoice_id: "INV-NEW", created_at: "2026-11-30T05:00:00Z", created_date: "2026-11-30" }),
      ],
      billings: [
        bill({ id: "B-OLD", term_start: "2025-12-01", period_index: 3, invoice_id: "INV-OLD" }),
        bill({ id: "B-NEW", term_start: "2026-12-01", period_index: 1, invoice_id: "INV-NEW" }),
      ] as never,
      invoices: [
        inv({ id: "INV-A", quote_id: "Q-A", status: "paid", paid_amount: 11800 }),
        inv({ id: "INV-OLD", quote_id: "PI-OLD", amount: 3000 }),
        inv({ id: "INV-NEW", quote_id: "PI-NEW", amount: 3540, invoice_date: "2026-11-30", created_at: "2026-11-30T05:00:00Z" }),
      ],
    });
    expect(docs?.renewalPartInvoiceIds).toEqual(["INV-NEW"]);
    expect(subscriptionOwedOf(sub, docs)?.total).toBe(6540);
    const prior = priorTermOwedOf(sub, docs);
    expect(prior?.total).toBe(3000);
    expect(prior?.invoices.map((i) => i.id)).toEqual(["INV-OLD"]);
  });

  /* review rev-r2818 #2: the at-risk "Unpaid balance" reason reads the same owed rule */
  it("at-risk 'Unpaid balance' reads the owed rule (Kochi shape: none), the stored balance only when no owed figure is given", () => {
    const sub = { used: 0, seats: 20, outstanding_amount: 25488, plan: "Google Workspace Business Standard", used_synced_at: null, written_off_at: null };
    expect(renewalRisk(sub, { owed: 0 }).reasons.some((r) => r.startsWith("Unpaid balance"))).toBe(false);
    expect(renewalRisk(sub, { owed: null }).reasons.some((r) => r.startsWith("Unpaid balance"))).toBe(false);   // documents not read: no guess
    expect(renewalRisk(sub, { owed: 28232 }).reasons).toContain("Unpaid balance (₹28.2K)");
    expect(renewalRisk(sub, { owed: 28232 }).score).toBe(35);
    const row = { sub: { ...sub, auto_renew: true, status: "active", renewal_state: "notice_sent" }, stage: null, daysUntil: 12, atRisk: true, owed: null };
    expect(topRiskReasons(row, TODAY).some((r) => r.startsWith("Unpaid balance"))).toBe(false);
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
    /* R-2838: the drawer lists payments through History — historyTabs keeps R-2818's no-receipt lines */
    /* R-2843 added `tds` to the options — further options are fine; docs + paid + subQuoteId + todayIst must stay */
    expect(drawer).toMatch(/historyTabs\(docs, paid, \{ subQuoteId, todayIst(?:, \w+)* \}\)/);
    expect(drawer).not.toMatch(/priorTermDue\(/);
    /* review #2: the at-risk reason and the CSV's "Outstanding (₹)" read it too — never sub.outstanding_amount */
    expect(items).toMatch(/renewalRisk\(r\.sub, \{ owed: owedOf\(r\.sub\) \}\)/);
    expect(items).not.toMatch(/renewalRisk\(r\.sub\)/);
    expect(page).not.toMatch(/renewalRisk\(sub\)/);
    expect(page).not.toMatch(/^\s*sub\.outstanding_amount,\s*$/m);
    expect(page).toMatch(/owedById\.get\(sub\.id\)/);
    const profile = read("src/components/features/customers/customer-profile.tsx");
    /* R-2884: the page's dues go through statementUninvoicedDues (lib/customers/statement-core.ts, pure — Help AI's
       customer_overview reads it too), which calls the ONE uninvoicedSubscriptionDue that owed.ts re-exports. */
    expect(profile).toMatch(/uninvoicedDues: statementUninvoicedDues\(allSubs, allInvoices\)/);
    expect(read("src/lib/customers/statement-core.ts")).toMatch(/uninvoicedSubscriptionDue\(s, invoicedQuoteIds\)/);
    expect(read("src/lib/renewals/owed.ts")).toMatch(/export \{ uninvoicedSubscriptionDue \}/);
  });
});
