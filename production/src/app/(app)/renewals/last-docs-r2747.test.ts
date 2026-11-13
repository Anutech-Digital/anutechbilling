/**
 * R-2747 (owner's Chrome check of R-2737, 13 Nov 2026):
 *   (a) the wide table cut the invoice line to "Invoice INV-… · Ove…" — the owner could not see the
 *       days overdue or the amount. Every line now WRAPS inside the Actions column (never cut).
 *   (b) "Previous term ₹x still unpaid" rows with no unpaid invoice line (SCN Kochi Hosting / SCN
 *       Delhi Traders: the balance sits only on subscriptions.outstanding_amount — no quote, no
 *       invoice linked) now say plainly why there is no invoice line.
 *   (c) a cancelled latest invoice is grey "Cancelled".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { invoiceStatusWords, lastDocsBySubscription, priorDueInvoiceGap, type LastDocs, type LastInvoice, type LastQuote } from "./last-docs";

const TODAY = "2026-11-13";
const li = (over: Partial<LastInvoice>): LastInvoice => ({
  id: "INV-1", date: "2026-10-01", status: "pending", amount: 11800, paidAmount: 0, currency: "INR",
  dueDate: null, netPayable: null, adjustedAdvances: null, writtenOffAt: null, fxRate: null,
  sourceQuoteId: null, part: null, period: null, notes: undefined, ...over,
});
const lq: LastQuote = { id: "Q-1", date: "2026-10-01", status: "sent", payment_status: "none", expires_date: null, invoice_id: null, part: null, period: null };
const docs = (over: Partial<LastDocs>): LastDocs => ({ quote: null, invoice: null, sent: null, ...over });

describe("R-2747 (b) previous term unpaid — the invoice line, or why there is none", () => {
  it("nothing owed on the previous term → no extra words", () => {
    expect(priorDueInvoiceGap(undefined, 0, TODAY)).toBeNull();
    expect(priorDueInvoiceGap(docs({}), 0, TODAY)).toBeNull();
  });
  it("an unpaid / overdue / part-paid invoice is shown → its own line says it, no extra words", () => {
    expect(priorDueInvoiceGap(docs({ invoice: li({ dueDate: "2026-11-20" }) }), 25488, TODAY)).toBeNull();
    expect(priorDueInvoiceGap(docs({ invoice: li({ dueDate: "2026-11-03" }) }), 25488, TODAY)).toBeNull();
    expect(priorDueInvoiceGap(docs({ invoice: li({ dueDate: "2026-11-20", paidAmount: 5000 }) }), 25488, TODAY)).toBeNull();
  });
  it("no quote, no invoice (SCN Kochi / SCN Delhi: balance only on the subscription) → says so; a renewal quote changes nothing", () => {
    const text = "No unpaid invoice linked to this subscription for the previous term";
    expect(priorDueInvoiceGap(undefined, 25488, TODAY)).toBe(text);
    expect(priorDueInvoiceGap(docs({}), 19258, TODAY)).toBe(text);
    /* a renewal quote covers only the new term — never implied to bill the old balance */
    expect(priorDueInvoiceGap(docs({ quote: lq }), 25488, TODAY)).toBe(text);
  });
  it("the last invoice is paid / cancelled and nothing older is owed → no unpaid invoice linked (never pretend one)", () => {
    const text = "No unpaid invoice linked to this subscription for the previous term";
    expect(priorDueInvoiceGap(docs({ invoice: li({ status: "paid", paidAmount: 11800 }) }), 25488, TODAY)).toBe(text);
    expect(priorDueInvoiceGap(docs({ invoice: li({ status: "void" }) }), 25488, TODAY)).toBe(text);
  });
  it("review: a newer PAID invoice is shown but an older linked one still owes → names that older invoice", () => {
    const d = docs({ invoice: li({ id: "INV-2", status: "paid", paidAmount: 11800 }), owedInvoiceId: "INV-1" });
    expect(priorDueInvoiceGap(d, 25488, TODAY)).toBe("Older invoice INV-1 still has money due");
  });
  it("lastDocsBySubscription records the newest owed linked invoice even when a newer paid one is shown", () => {
    const SUB = "c2747000-0000-4000-8000-0000000000a1";
    const out = lastDocsBySubscription({
      subs: [{ id: SUB, quote_id: "Q-1", renewal_quote_id: "Q-2", start_date: "2025-10-01" }],
      quotes: [
        { id: "Q-1", status: "accepted", payment_status: "invoiced", created_at: "2025-10-01T05:00:00Z", created_date: "2025-10-01", expires_date: null, invoice_id: "INV-1", renewal_subscription_id: null, add_seats_subscription_id: null, subscription_billing_id: null, superseded_by: null },
        { id: "Q-2", status: "accepted", payment_status: "paid", created_at: "2026-10-01T05:00:00Z", created_date: "2026-10-01", expires_date: null, invoice_id: "INV-2", renewal_subscription_id: SUB, add_seats_subscription_id: null, subscription_billing_id: null, superseded_by: null },
      ],
      billings: [],
      invoices: [
        { id: "INV-1", quote_id: "Q-1", invoice_date: "2025-10-01", status: "pending", amount: 25488, paid_amount: 0, currency: "INR", created_at: "2025-10-01T05:00:00Z", due_date: "2025-10-15" },
        { id: "INV-2", quote_id: "Q-2", invoice_date: "2026-10-01", status: "paid", amount: 11800, paid_amount: 11800, currency: "INR", created_at: "2026-10-01T05:00:00Z", due_date: null },
      ],
    });
    const d = out.get(SUB)!;
    expect(d.invoice?.id).toBe("INV-2");
    expect(d.owedInvoiceId).toBe("INV-1");
    expect(priorDueInvoiceGap(d, 25488, TODAY)).toBe("Older invoice INV-1 still has money due");
  });
});

describe("R-2747 (c) a cancelled latest invoice is grey", () => {
  it("void / cancelled → 'Cancelled' in the muted (grey) tone, and muted = text-ink-3 in the cell", () => {
    expect(invoiceStatusWords(li({ status: "void" }), TODAY)).toEqual({ text: "Cancelled", tone: "muted" });
    expect(invoiceStatusWords(li({ status: "cancelled", dueDate: "2026-10-01" }), TODAY)).toEqual({ text: "Cancelled", tone: "muted" });
    const cell = readFileSync("src/app/(app)/renewals/last-docs-cell.tsx", "utf8");
    expect(cell).toMatch(/muted: "text-ink-3"/);
  });
});

describe("R-2747 (a) the lines wrap inside the column — never cut", () => {
  const cell = readFileSync("src/app/(app)/renewals/last-docs-cell.tsx", "utf8");
  const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
  const block = cell.slice(cell.indexOf("export function LastDocsLines"), cell.indexOf("export function SentDueLines"));
  it("no line in the docs block truncates; each wraps (break-words) inside the bounded wrapper", () => {
    expect(block).toMatch(/"w-full min-w-0 max-w-full[^"]*"[^>]*data-testid="renewal-last-docs"/);
    expect(block).not.toMatch(/\btruncate\b/);
    const paras = block.slice(block.indexOf('data-testid="renewal-last-docs"')).match(/<p className=[^>]*>/g) ?? [];
    expect(paras.length).toBe(5);
    for (const p of paras) expect(p).toMatch(/break-words/);
  });
  it("the page passes the previous-term amount to the docs lines (one rule: priorTermDue)", () => {
    expect(page).toMatch(/<LastDocsLines [^>]*priorDue=\{priorTermDue\(item\.sub\)\}/);
  });
});
