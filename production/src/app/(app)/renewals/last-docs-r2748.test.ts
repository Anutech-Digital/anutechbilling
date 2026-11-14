/**
 * R-2748 (Pardeep, 13 Nov 2026): "renewal page par last two invoices and related quotes with payment
 * status show hone chahiye". Each row: up to TWO linked invoices, newest first, each with its total,
 * state (Paid / Part paid / Unpaid / Overdue N d / Cancelled), period and the quote it came from.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  lastDocsBySubscription, invoiceTotalWords, sourceQuoteState, attachDocDetails, detailQuoteIds, shownInvoiceIds,
  type LastDocsInput, type DocQuote, type DocInvoice, type LastInvoice,
} from "./last-docs";

const SUB = "c2748000-0000-4000-8000-0000000000a1";

const q = (over: Partial<DocQuote> & { id: string }): DocQuote => ({
  status: "accepted", payment_status: "invoiced", created_at: "2025-10-01T05:00:00Z", created_date: "2025-10-01",
  expires_date: null, invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null,
  subscription_billing_id: null, superseded_by: null, ...over,
});
const inv = (over: Partial<DocInvoice> & { id: string }): DocInvoice => ({
  quote_id: null, invoice_date: "2025-10-01", status: "pending", amount: 11800, paid_amount: 0, currency: "INR",
  created_at: "2025-10-01T05:00:00Z", due_date: null, ...over,
});
const input = (over: Partial<LastDocsInput>): LastDocsInput => ({
  subs: [{ id: SUB, quote_id: "Q-A", renewal_quote_id: null, start_date: "2025-10-01" }],
  quotes: [], billings: [], invoices: [], ...over,
});
const ids = (l: LastInvoice[]) => l.map((i) => i.id);

describe("R-2748 the last two invoices, newest first", () => {
  it("three linked invoices → the two newest, newest first; `invoice` is the newest", () => {
    const out = lastDocsBySubscription(input({
      quotes: [
        q({ id: "Q-A", invoice_id: "INV-1" }),
        q({ id: "Q-B", renewal_subscription_id: SUB, invoice_id: "INV-2", created_at: "2026-01-01T05:00:00Z" }),
        q({ id: "Q-C", renewal_subscription_id: SUB, invoice_id: "INV-3", created_at: "2026-10-01T05:00:00Z" }),
      ],
      invoices: [
        inv({ id: "INV-1", quote_id: "Q-A", status: "paid", paid_amount: 11800 }),
        inv({ id: "INV-3", quote_id: "Q-C", invoice_date: "2026-10-01" }),
        inv({ id: "INV-2", quote_id: "Q-B", invoice_date: "2026-01-01", status: "paid", paid_amount: 11800 }),
      ],
    })).get(SUB)!;
    expect(ids(out.invoices)).toEqual(["INV-3", "INV-2"]);
    expect(out.invoice?.id).toBe("INV-3");
  });

  it("review: an older invoice still OWED is never pushed off by two newer paid ones", () => {
    const out = lastDocsBySubscription(input({
      quotes: [
        q({ id: "Q-A", invoice_id: "INV-OWED" }),
        q({ id: "Q-B", renewal_subscription_id: SUB, invoice_id: "INV-P1", created_at: "2026-01-01T05:00:00Z" }),
        q({ id: "Q-C", renewal_subscription_id: SUB, invoice_id: "INV-P2", created_at: "2026-10-01T05:00:00Z" }),
      ],
      invoices: [
        inv({ id: "INV-OWED", quote_id: "Q-A", due_date: "2025-10-15" }),
        inv({ id: "INV-P1", quote_id: "Q-B", invoice_date: "2026-01-01", status: "paid", paid_amount: 11800 }),
        inv({ id: "INV-P2", quote_id: "Q-C", invoice_date: "2026-10-01", status: "paid", paid_amount: 11800 }),
      ],
    })).get(SUB)!;
    expect(ids(out.invoices)).toEqual(["INV-P2", "INV-OWED"]);
  });

  it("one invoice → a list of one; none → []", () => {
    const one = lastDocsBySubscription(input({ quotes: [q({ id: "Q-A", invoice_id: "INV-1" })], invoices: [inv({ id: "INV-1", quote_id: "Q-A" })] })).get(SUB)!;
    expect(ids(one.invoices)).toEqual(["INV-1"]);
    expect(lastDocsBySubscription(input({})).get(SUB)!.invoices).toEqual([]);
  });

  it("a newer VOID and an older owed one → both shown (void first, the owed one never hidden); `invoice` stays the owed one (R-2737)", () => {
    const out = lastDocsBySubscription(input({
      quotes: [q({ id: "Q-A", invoice_id: "INV-OWED" }), q({ id: "Q-V", renewal_subscription_id: SUB, invoice_id: "INV-VOID" })],
      invoices: [
        inv({ id: "INV-OWED", quote_id: "Q-A", due_date: "2025-10-15" }),
        inv({ id: "INV-VOID", quote_id: "Q-V", invoice_date: "2026-11-01", status: "void" }),
      ],
    })).get(SUB)!;
    expect(ids(out.invoices)).toEqual(["INV-VOID", "INV-OWED"]);
    expect(out.invoice?.id).toBe("INV-OWED");
  });

  it("drafts never count; an invoice of ANOTHER subscription never shows", () => {
    const out = lastDocsBySubscription(input({
      quotes: [q({ id: "Q-A", invoice_id: "INV-1" }), q({ id: "Q-X", invoice_id: "INV-X" })],
      invoices: [
        inv({ id: "INV-1", quote_id: "Q-A" }),
        inv({ id: "INV-D", quote_id: "Q-A", invoice_date: "2026-11-10", status: "draft" }),
        inv({ id: "INV-X", quote_id: "Q-X", invoice_date: "2026-11-11" }),
      ],
    })).get(SUB)!;
    expect(ids(out.invoices)).toEqual(["INV-1"]);
  });

  it("each invoice carries the quote it came from — by invoices.quote_id or by the quote's invoice_id", () => {
    const out = lastDocsBySubscription(input({
      quotes: [
        q({ id: "Q-A", invoice_id: "INV-1", status: "accepted" }),
        q({ id: "Q-B", renewal_subscription_id: SUB, invoice_id: "INV-2", status: "sent", payment_status: "received" }),
      ],
      invoices: [inv({ id: "INV-1", quote_id: null }), inv({ id: "INV-2", quote_id: "Q-B", invoice_date: "2026-10-01" })],
    })).get(SUB)!;
    const [n, o] = out.invoices;
    expect(n.sourceQuote?.id).toBe("Q-B");
    expect(o.sourceQuote?.id).toBe("Q-A");
    expect(sourceQuoteState(o.sourceQuote!)).toBe("Accepted");   // "Invoiced" says nothing next to its invoice
    /* review: never a payment word — the quote says "received" but the invoice line owns Paid / Overdue */
    expect(sourceQuoteState(n.sourceQuote!)).toBe("Sent");
  });

  it("the invoice's whole value in its own currency", () => {
    const [i] = lastDocsBySubscription(input({ quotes: [q({ id: "Q-A", invoice_id: "INV-1" })], invoices: [inv({ id: "INV-1", quote_id: "Q-A", amount: 40000 })] })).get(SUB)!.invoices;
    expect(invoiceTotalWords(i)).toBe("₹40,000");
    expect(invoiceTotalWords({ ...i, amount: 100800, currency: "USD", fxRate: 84 })).toBe("$1,200");
  });

  it("details (period, credit notes) are read for BOTH shown invoices — still one batched round", () => {
    const docs = lastDocsBySubscription(input({
      quotes: [q({ id: "Q-A", invoice_id: "INV-1" }), q({ id: "Q-B", renewal_subscription_id: SUB, invoice_id: "INV-2" })],
      invoices: [inv({ id: "INV-1", quote_id: "Q-A" }), inv({ id: "INV-2", quote_id: "Q-B", invoice_date: "2026-10-01" })],
    }));
    expect(shownInvoiceIds(docs)).toEqual(["INV-1", "INV-2"]);
    expect(detailQuoteIds(docs)).toEqual(["Q-A", "Q-B"]);
    const withNotes = attachDocDetails(docs, { quotes: [], notes: new Map([["INV-1", { credit: 11800, debit: 0 }]]) }).get(SUB)!;
    expect(withNotes.invoices.find((i) => i.id === "INV-1")?.notes).toEqual({ credit: 11800, debit: 0 });
    expect(withNotes.invoices.find((i) => i.id === "INV-2")?.notes).toEqual({ credit: 0, debit: 0 });
    /* review: `invoice` is the same object as its entry in `invoices` — one copy of each fact */
    expect(withNotes.invoices).toContain(withNotes.invoice);
  });
});

describe("R-2748 the cell", () => {
  const cell = readFileSync("src/app/(app)/renewals/last-docs-cell.tsx", "utf8");
  const data = readFileSync("src/app/(app)/renewals/last-docs-data.ts", "utf8");
  it("renders the list (newest first) with total, state, period and 'from <quote>'; numbers are links", () => {
    expect(cell).toMatch(/invoices\.map\(\(inv, n\) =>/);
    expect(cell).toContain('data-testid="renewal-invoice-total"');
    expect(cell).toContain('data-testid="renewal-invoice-quote"');
    expect(cell).toMatch(/from <DocLink id=\{src\.id\} href=\{canQuotes \?/);
    expect(cell).toMatch(/data-invoice-id=\{invoice\.id\}/);
  });
  it("the newest quote sent is not repeated when it is a shown invoice's own quote (one fact one place)", () => {
    expect(cell).toMatch(/!invoices\.some\(\(i\) => i\.sourceQuoteId === docs\.quote\?\.id\)/);
  });
  it("no new per-row read: the same 9 batched reads as R-2737", () => {
    expect((data.match(/fetchAllRowsIn</g) ?? []).length).toBe(9);
    expect(data).not.toMatch(/\.single\(\)|\.maybeSingle\(\)/);
  });
});
