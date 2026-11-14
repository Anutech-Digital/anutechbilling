/**
 * R-2737 (Pardeep, 13 Nov 2026 — Pratik's daily /renewals): "last invoice ke status bhi show hona
 * chahiye, uska subscription period bhi show hona chahiye".
 *   (a) the last invoice's real payment state — Paid · Part paid ₹x due · Unpaid ₹x · Overdue Nd ·
 *       Cancelled — from the same rules as /invoices (overdue.ts, payment-state.ts, IST);
 *   (b) the period it covers, from the same source the invoice paper prints (a billed part's
 *       subscription_billings period; else the quote lines' "Subscription period", R-1764);
 *   (c) a foreign-currency invoice in its own currency; (d) the text never widens the table.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  lastDocsBySubscription, invoiceStatusWords, periodWords, partPeriodWords, quoteLinesPeriod, attachDocDetails,
  type LastDocsInput, type DocQuote, type DocBilling, type DocInvoice, type LastInvoice, type DocQuoteDetail,
} from "./last-docs";

const SUB = "c2737000-0000-4000-8000-0000000000a1";
const TODAY = "2026-11-13";

const q = (over: Partial<DocQuote> & { id: string }): DocQuote => ({
  status: "sent", payment_status: "none", created_at: "2026-11-01T05:00:00Z", created_date: "2026-11-01",
  expires_date: null, invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null,
  subscription_billing_id: null, superseded_by: null, ...over,
});
const inv = (over: Partial<DocInvoice> & { id: string }): DocInvoice => ({
  quote_id: null, invoice_date: "2026-11-01", status: "pending", amount: 11800, paid_amount: 0, currency: "INR",
  created_at: "2026-11-01T05:00:00Z", due_date: null, ...over,
});
const bill = (over: Partial<DocBilling> & { id: string }): DocBilling => ({
  subscription_id: SUB, invoice_id: null, term_start: "2026-10-01", period_index: 1, ...over,
});
const input = (over: Partial<LastDocsInput>): LastDocsInput => ({
  subs: [{ id: SUB, quote_id: "Q-ORIG", renewal_quote_id: null, start_date: "2025-10-01" }],
  quotes: [], billings: [], invoices: [], ...over,
});
const li = (over: Partial<LastInvoice>): LastInvoice => ({
  id: "INV-1", date: "2026-10-01", status: "pending", amount: 11800, paidAmount: 0, currency: "INR",
  dueDate: null, netPayable: null, adjustedAdvances: null, writtenOffAt: null, fxRate: null,
  sourceQuoteId: null, part: null, period: null, notes: undefined, ...over,
});
const detail = (over: Partial<DocQuoteDetail> & { id: string }): DocQuoteDetail => ({
  line_items: [{ name: "Google Workspace Business Starter", commitment: "annual_monthly" }],
  is_renewal: false, is_extension: false, is_add_seats: false, is_one_off: false, extension_months: null,
  renewal_term_date: null, created_date: "2025-12-01", ...over,
});

describe("R-2737 (a) last invoice status words — the /invoices rules, IST", () => {
  it("paid / part paid / unpaid not yet due / no due date is never overdue", () => {
    expect(invoiceStatusWords(li({ status: "paid", paidAmount: 11800 }), TODAY)).toEqual({ text: "Paid", tone: "ok" });
    expect(invoiceStatusWords(li({ paidAmount: 7900, dueDate: "2026-11-20" }), TODAY)).toEqual({ text: "Part paid · ₹3,900 due", tone: "warn" });
    expect(invoiceStatusWords(li({ dueDate: "2026-11-20" }), TODAY)).toEqual({ text: "Unpaid · ₹11,800", tone: "warn" });
    expect(invoiceStatusWords(li({ dueDate: null }), TODAY).text).toBe("Unpaid · ₹11,800");
  });

  it("overdue boundaries in IST: due today → Unpaid; due yesterday → Overdue 1d; 43 days → Overdue 43d", () => {
    expect(invoiceStatusWords(li({ dueDate: TODAY }), TODAY).text).toBe("Unpaid · ₹11,800");
    expect(invoiceStatusWords(li({ dueDate: "2026-11-12" }), TODAY)).toEqual({ text: "Overdue 1d · ₹11,800", tone: "danger" });
    expect(invoiceStatusWords(li({ dueDate: "2026-10-01" }), TODAY).text).toBe("Overdue 43d · ₹11,800");
    expect(invoiceStatusWords(li({ dueDate: "2026-10-01", paidAmount: 7900 }), TODAY).text).toBe("Overdue 43d · ₹3,900 due");
  });

  it("void → Cancelled (greyed); a credit note for the whole value → Cancelled, never Paid; written off", () => {
    expect(invoiceStatusWords(li({ status: "void" }), TODAY)).toEqual({ text: "Cancelled", tone: "muted" });
    expect(invoiceStatusWords(li({ status: "cancelled" }), TODAY).text).toBe("Cancelled");
    expect(invoiceStatusWords(li({ status: "paid", notes: { credit: 11800, debit: 0 } }), TODAY)).toEqual({ text: "Cancelled · credit note", tone: "muted" });
    expect(invoiceStatusWords(li({ status: "paid", paidAmount: 0, notes: undefined }), TODAY).text).toBe("Paid");
    expect(invoiceStatusWords(li({ writtenOffAt: "2026-11-01T00:00:00Z", dueDate: "2026-10-01" }), TODAY)).toEqual({ text: "Written off", tone: "muted" });
  });

  it("advances adjusted at issue lower what is due (net_payable), as the dunning engine reads it", () => {
    expect(invoiceStatusWords(li({ netPayable: 5900, dueDate: "2026-11-20" }), TODAY).text).toBe("Unpaid · ₹5,900");
  });

  it("a USD invoice shows its own currency, never a ₹ figure or a blank", () => {
    expect(invoiceStatusWords(li({ currency: "USD", fxRate: 84, amount: 100800, paidAmount: 42000, dueDate: "2026-11-20" }), TODAY).text).toBe("Part paid · $700 due");
    expect(invoiceStatusWords(li({ currency: "USD", fxRate: 84, amount: 100800, dueDate: "2026-11-01" }), TODAY).text).toBe("Overdue 12d · $1,200");
    expect(invoiceStatusWords(li({ currency: "USD", fxRate: 83.5, amount: 1000, dueDate: "2026-11-20" }), TODAY).text).toBe("Unpaid · $11.98");
    /* no rate stored → the ₹ the books hold, with the currency named */
    expect(invoiceStatusWords(li({ currency: "USD", fxRate: null, amount: 100800, dueDate: "2026-11-20" }), TODAY).text).toBe("Unpaid · ₹1,00,800 (USD)");
  });
});

describe("R-2737 (b) the period a document covers", () => {
  it("period words: a calendar month, a quarter, a whole term, multi-year", () => {
    expect(periodWords("2026-11-01", "2026-11-30")).toBe("Nov 2026");
    expect(periodWords("2026-11-01", "2027-01-31")).toBe("Nov 2026 – Jan 2027");
    expect(periodWords("2026-11-01", "2027-10-31", 12)).toBe("1 Nov 2026 – 31 Oct 2027");
    expect(periodWords("2025-12-01", "2028-11-30", 36)).toBe("1 Dec 2025 – 30 Nov 2028 (3 yr)");
    expect(periodWords("2026-11-12", "2026-12-11")).toBe("12 Nov 2026 – 11 Dec 2026");
  });

  it("a billed part's stored period (period_end is exclusive) — month, quarter, half-year", () => {
    expect(partPeriodWords("2026-11-01", "2026-12-01")).toBe("Nov 2026");
    expect(partPeriodWords("2026-10-01", "2027-01-01")).toBe("Oct 2026 – Dec 2026");
    expect(partPeriodWords("2026-10-01", "2027-04-01")).toBe("Oct 2026 – Mar 2027");
    expect(partPeriodWords("2026-10-07", "2027-01-07")).toBe("7 Oct 2026 – 6 Jan 2027");
    expect(partPeriodWords(null, "2027-01-01")).toBeNull();
  });

  it("whole-quote period = the invoice paper's 'Subscription period' (lineServicePeriod)", () => {
    /* original sale: the line's start_date (else the quote's date) + one term */
    expect(quoteLinesPeriod(detail({ id: "Q-ORIG", line_items: [{ name: "GWS", commitment: "annual_monthly", start_date: "2025-12-01" }] })))
      .toBe("1 Dec 2025 – 30 Nov 2026");
    /* renewal: renewal_term_date + extension_months */
    expect(quoteLinesPeriod(detail({ id: "Q-REN", is_renewal: true, renewal_term_date: "2026-11-30", extension_months: 12 })))
      .toBe("1 Dec 2026 – 30 Nov 2027");
    /* multi-year domain (R-2710/R-2712) */
    expect(quoteLinesPeriod(detail({ id: "Q-DOM", line_items: [{ name: "example.in", commitment: "annual_yearly", years: 3, start_date: "2025-12-01" }] })))
      .toBe("1 Dec 2025 – 30 Nov 2028 (3 yr)");
    /* renewal quote with no renewal_term_date: the paper prints no period, so neither do we (no guess) */
    expect(quoteLinesPeriod(detail({ id: "Q-REN2", is_renewal: true, renewal_term_date: null, extension_months: 12 }))).toBeNull();
    /* one-off sale: no period */
    expect(quoteLinesPeriod(detail({ id: "Q-ONE", is_one_off: true }))).toBeNull();
  });
});

describe("R-2737 one invoice, several subscriptions — each row shows ITS line's period (owner, 13 Nov)", () => {
  const SUB_B = "c2737000-0000-4000-8000-0000000000b2";
  const lines = [
    { name: "Google Workspace Business Starter", commitment: "annual_yearly", domain: "a.in", start_date: "2026-01-01" },
    { name: "Microsoft 365 Business Basic", commitment: "annual_yearly", domain: "b.in", start_date: "2026-04-01" },
    { name: "Setup fee", one_time: true },
  ];
  const twoSubs = [
    { id: SUB, quote_id: "Q-2L", renewal_quote_id: null, start_date: "2026-01-01", plan: "Google Workspace Business Starter", domain: "a.in" },
    { id: SUB_B, quote_id: "Q-2L", renewal_quote_id: null, start_date: "2026-04-01", plan: "Microsoft 365 Business Basic", domain: "b.in" },
  ];
  it("a 2-line invoice (two subscriptions, different periods) → each renewal row its own period", () => {
    const m = lastDocsBySubscription({
      subs: twoSubs, billings: [],
      quotes: [q({ id: "Q-2L", status: "accepted", payment_status: "received", invoice_id: "INV-2L" })],
      invoices: [inv({ id: "INV-2L", quote_id: "Q-2L", status: "paid", paid_amount: 11800 })],
    });
    const out = attachDocDetails(m, { quotes: [detail({ id: "Q-2L", line_items: lines })], notes: new Map() }, twoSubs);
    expect(out.get(SUB)!.invoice!.period).toBe("1 Jan 2026 – 31 Dec 2026");
    expect(out.get(SUB_B)!.invoice!.period).toBe("1 Apr 2026 – 31 Mar 2027");
  });
  it("matching: plan + domain, then plan, then domain (renamed plan); a bulk line by its domains; two lines of one subscription → their range; nothing → no period", () => {
    const d = detail({ id: "Q", line_items: lines });
    expect(quoteLinesPeriod(d, { id: "x", plan: "Microsoft 365 Business Basic", domain: null })).toBe("1 Apr 2026 – 31 Mar 2027");
    expect(quoteLinesPeriod(d, { id: "x", plan: "Renamed plan", domain: "a.in" })).toBe("1 Jan 2026 – 31 Dec 2026");
    expect(quoteLinesPeriod(d, { id: "x", plan: "Something else", domain: "zzz.in" })).toBeNull();
    const bulk = detail({ id: "Q", line_items: [
      lines[0],
      { name: "Google Workspace Business Starter", commitment: "annual_yearly", bulk: true, start_date: "2026-06-01", domains: [{ domain: "c.in", seats: 2 }, { domain: "d.in", seats: 1 }] },
    ] });
    expect(quoteLinesPeriod(bulk, { id: "x", plan: "Google Workspace Business Starter", domain: "d.in" })).toBe("1 Jun 2026 – 31 May 2027");
    const twoOfOne = detail({ id: "Q", line_items: [lines[0], { ...lines[0], start_date: "2026-03-01" }, lines[1]] });
    expect(quoteLinesPeriod(twoOfOne, { id: "x", plan: "Google Workspace Business Starter", domain: "a.in" })).toBe("1 Jan 2026 – 28 Feb 2027");
    /* a one-off line next to ONE subscription line: that line is the subscription's */
    expect(quoteLinesPeriod(detail({ id: "Q", line_items: [lines[0], lines[2]] }), { id: "x", plan: "Other", domain: null })).toBe("1 Jan 2026 – 31 Dec 2026");
  });
  it("one invoice billing parts of two subscriptions → each row its own billed part", () => {
    const m = lastDocsBySubscription({
      subs: twoSubs, quotes: [],
      billings: [
        bill({ id: "b1", subscription_id: SUB, invoice_id: "INV-P", period_start: "2026-10-01", period_end: "2027-01-01" }),
        bill({ id: "b2", subscription_id: SUB_B, invoice_id: "INV-P", period_start: "2026-11-01", period_end: "2026-12-01" }),
      ],
      invoices: [inv({ id: "INV-P" })],
    });
    const out = attachDocDetails(m, { quotes: [], notes: new Map() }, twoSubs);
    expect(out.get(SUB)!.invoice!.period).toBe("Oct 2026 – Dec 2026");
    expect(out.get(SUB_B)!.invoice!.period).toBe("Nov 2026");
  });
});

describe("R-2737 which invoice + which period source", () => {
  it("the newest invoice is shown even when cancelled (greyed); an older paid one does not hide it", () => {
    const m = lastDocsBySubscription(input({
      quotes: [q({ id: "Q-ORIG", status: "accepted", payment_status: "received", invoice_id: "INV-1" })],
      invoices: [
        inv({ id: "INV-1", quote_id: "Q-ORIG", invoice_date: "2025-10-02", status: "paid", paid_amount: 11800 }),
        inv({ id: "INV-CN", quote_id: null, invoice_date: "2026-10-02", status: "void" }),
        inv({ id: "INV-DRAFT", quote_id: "Q-ORIG", invoice_date: "2026-10-05", status: "draft" }),
      ],
      billings: [bill({ id: "b1", invoice_id: "INV-CN", period_start: "2026-10-01", period_end: "2027-01-01" })],
    }));
    const i = m.get(SUB)!.invoice!;
    expect(i.id).toBe("INV-CN");
    expect(invoiceStatusWords(i, TODAY).text).toBe("Cancelled");
  });

  it("review: a newer void invoice never hides an older one with money still owed", () => {
    const m = lastDocsBySubscription(input({
      billings: [
        bill({ id: "b1", invoice_id: "INV-P1", period_start: "2026-07-01", period_end: "2026-10-01" }),
        bill({ id: "b2", period_index: 2, invoice_id: "INV-P2", period_start: "2026-10-01", period_end: "2027-01-01" }),
      ],
      invoices: [
        inv({ id: "INV-P1", invoice_date: "2026-07-01", due_date: "2026-10-01", amount: 3540 }),
        inv({ id: "INV-P2", invoice_date: "2026-10-01", status: "void", amount: 3540 }),
      ],
    }));
    expect(m.get(SUB)!.invoice!.id).toBe("INV-P1");
    expect(m.get(SUB)!.invoice!.part).toEqual({ start: "2026-07-01", endExclusive: "2026-10-01" });
  });

  it("review: nothing left to collect but not marked paid (advance adjusted) → 'Covered by advance', never 'Paid'", () => {
    expect(invoiceStatusWords(li({ netPayable: 0, adjustedAdvances: [{ payment_id: "p", amount: 11800 }] }), TODAY).text).toBe("Covered by advance");
  });

  it("review: same plan on lines for two domains and the subscription's domain matches neither → no period, not a merged range", () => {
    const d = detail({ id: "Q", line_items: [
      { name: "GWS", commitment: "annual_yearly", domain: "a.com", start_date: "2026-01-01" },
      { name: "GWS", commitment: "annual_yearly", domain: "b.com", start_date: "2026-04-01" },
    ] });
    expect(quoteLinesPeriod(d, { id: "x", plan: "GWS", domain: null })).toBeNull();
    expect(quoteLinesPeriod(d, { id: "x", plan: "GWS", domain: "b.com" })).toBe("1 Apr 2026 – 31 Mar 2027");
  });

  it("a part invoice takes the billing row's period; a whole-quote invoice its quote's lines; the quote line too", () => {
    const m = lastDocsBySubscription(input({
      subs: [{ id: SUB, quote_id: "Q-ORIG", renewal_quote_id: "Q-REN", start_date: "2025-10-01" }],
      quotes: [
        q({ id: "Q-ORIG", status: "accepted", payment_status: "invoiced", invoice_id: "INV-1", created_at: "2025-10-01T05:00:00Z" }),
        q({ id: "PI-1", status: "accepted", payment_status: "invoiced", created_at: "2026-10-01T05:00:00Z", subscription_billing_id: "b2" }),
        q({ id: "Q-REN", status: "sent", created_at: "2026-11-05T05:00:00Z", renewal_subscription_id: SUB }),
      ],
      billings: [bill({ id: "b2", invoice_id: null, period_start: "2026-10-01", period_end: "2027-01-01" })],
      invoices: [
        inv({ id: "INV-1", quote_id: "Q-ORIG", invoice_date: "2025-10-02", status: "paid", paid_amount: 11800 }),
        inv({ id: "INV-P2", quote_id: "PI-1", invoice_date: "2026-10-02", due_date: "2026-10-01" }),
      ],
    }));
    const d = m.get(SUB)!;
    expect(d.invoice).toMatchObject({ id: "INV-P2", part: { start: "2026-10-01", endExclusive: "2027-01-01" } });
    expect(d.quote).toMatchObject({ id: "Q-REN", part: null });
    const out = attachDocDetails(m, {
      quotes: [detail({ id: "Q-REN", is_renewal: true, renewal_term_date: "2026-11-30", extension_months: 12 })],
      notes: new Map(),
    });
    expect(out.get(SUB)!.invoice!.period).toBe("Oct 2026 – Dec 2026");
    expect(out.get(SUB)!.quote!.period).toBe("1 Dec 2026 – 30 Nov 2027");
    expect(invoiceStatusWords(out.get(SUB)!.invoice!, TODAY).text).toBe("Overdue 43d · ₹11,800");
  });

  it("a whole-quote invoice reads its source quote's lines; notes read → credited state known", () => {
    const m = lastDocsBySubscription(input({
      quotes: [q({ id: "Q-ORIG", status: "accepted", payment_status: "received", invoice_id: "INV-1" })],
      invoices: [inv({ id: "INV-1", quote_id: null, invoice_date: "2025-10-02", status: "paid", paid_amount: 11800 })],
    }));
    expect(m.get(SUB)!.invoice).toMatchObject({ sourceQuoteId: "Q-ORIG", part: null });
    const out = attachDocDetails(m, {
      quotes: [detail({ id: "Q-ORIG", line_items: [{ name: "GWS", commitment: "annual_monthly", start_date: "2025-10-01" }] })],
      notes: new Map([["INV-1", { credit: 11800, debit: 0 }]]),
    });
    expect(out.get(SUB)!.invoice!.period).toBe("1 Oct 2025 – 30 Sep 2026");
    expect(invoiceStatusWords(out.get(SUB)!.invoice!, TODAY).text).toBe("Cancelled · credit note");
  });

  it("details not read (failed) → no period, state from the invoice alone", () => {
    const m = lastDocsBySubscription(input({
      quotes: [q({ id: "Q-ORIG", status: "accepted", payment_status: "received", invoice_id: "INV-1" })],
      invoices: [inv({ id: "INV-1", quote_id: "Q-ORIG", status: "paid", paid_amount: 11800 })],
    }));
    const out = attachDocDetails(m, null);
    expect(out.get(SUB)!.invoice!.period).toBeNull();
    expect(out.get(SUB)!.invoice!.notes).toBeUndefined();
  });
});

describe("R-2737 (d) the cell never widens the table; one batched read", () => {
  const cell = readFileSync("src/app/(app)/renewals/last-docs-cell.tsx", "utf8");
  const data = readFileSync("src/app/(app)/renewals/last-docs-data.ts", "utf8");
  it("the wrapper is bounded (w-full min-w-0) and every line stays inside the column, the full text in a title", () => {
    const block = cell.slice(cell.indexOf("export function LastDocsLines"), cell.indexOf("export function SentDueLines"));
    expect(block).toMatch(/"w-full min-w-0 max-w-full[^"]*"[^>]*data-testid="renewal-last-docs"/);
    /* every text line inside the docs block stays inside the column — R-2747: it wraps, never cut */
    const docsBlock = block.slice(block.indexOf('data-testid="renewal-last-docs"'));
    const paras = docsBlock.match(/<p className=[^>]*>/g) ?? [];
    expect(paras.length).toBe(5);
    for (const p of paras) expect(p).toMatch(/break-words/);
    /* the full words live in a title on each document */
    /* R-2748: an invoice's title starts with its label ("Last invoice" / "Earlier invoice") */
    expect((block.match(/title=\{`(Last quote sent|\$\{label\}):/g) ?? []).length).toBe(2);
    expect(block).toContain('"Last invoice" : "Earlier invoice"');
    expect(cell).not.toContain("invoicePaidText");
  });
  it("details come in ONE extra round of batched reads (no per-row read)", () => {
    expect(data).toContain("attachDocDetails");
    expect(data).toContain("credit_notes");
    expect(data).toContain("debit_notes");
    expect(data).not.toMatch(/\.single\(\)|\.maybeSingle\(\)/);
    expect((data.match(/fetchAllRowsIn</g) ?? []).length).toBe(9);
  });
});
