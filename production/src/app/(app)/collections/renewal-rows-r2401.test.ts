/**
 * R-2401 — Payment Follow-up also chases renewals (Pardeep, 3 Nov: "payment follow up wala hi
 * renewal handle karta hai to payment follow up me renewal manage karne ka system bhi hona chahiye").
 *
 * Owner's path: Renewals → "Expired · in grace" (REDOQ / BITDECENTRO / SAV / SEOAK) — none of them
 * has an invoice, so /collections did not list them at all. Now a renewal due in ≤7 days or already
 * past its date, not paid, not Won't renew, is a "Renewal" line on that customer's row.
 */
import { describe, it, expect } from "vitest";
import {
  buildCollectionRows, fetchCollectionsInput, receivableLines,
  type CollectionInvoice, type CollectionRenewalSub, type CollectionsInput,
} from "@/lib/queries/collections";

const TODAY = "2026-11-03";

function ren(p: Partial<CollectionRenewalSub> & { id: string }): CollectionRenewalSub {
  return {
    customer_id: "c1", customer_name: "REDOQ", plan: "Workspace Business", domain: "redoq.in", quote_id: "Q-OLD",
    renewal_quote_id: null, renewal_date: "2026-10-28", renewal_state: "grace_period", status: "active",
    auto_renew: true, billing_cycle: "yearly", term_months: 12, mrr: 1000, term_amount: 12000,
    grace_until: null, outstanding_amount: 0, start_date: "2025-10-28", ...p,
  };
}
function inv(p: Partial<CollectionInvoice> & { id: string }): CollectionInvoice {
  return {
    customer_id: "c1", customer_name: "REDOQ", amount: 14160, net_payable: 14160, paid_amount: 0,
    status: "pending", invoice_date: "2026-10-28", due_date: "2026-10-28", quote_id: null,
    taxable_value: 12000, tax_amount: 2160, tax_rate: 18, ...p,
  };
}
function input(p: Partial<CollectionsInput> = {}): CollectionsInput {
  return {
    invoices: [], subscriptions: [], quoteSubscriptions: [], invoicedQuoteIds: new Set(),
    customers: [
      { id: "c1", name: "REDOQ", display_name: null, account_manager_id: null },
      { id: "c2", name: "SEOAK", display_name: null, account_manager_id: null },
    ],
    followups: [], renewals: [], renewalQuotes: [], ...p,
  };
}

describe("R-2401: renewal rows on Payment Follow-up", () => {
  it("an expired-in-grace renewal with no invoice is listed as kind 'renewal', term amount marked est.", () => {
    const rows = buildCollectionRows(input({ renewals: [ren({ id: "s1" })] }), TODAY);
    expect(rows).toHaveLength(1);
    const [item] = rows[0].renewals;
    expect(rows[0].items).toEqual([]);
    expect(item).toMatchObject({ kind: "renewal", id: "s1", amount: 12000, estimate: true, daysOverdue: 6, renewalDate: "2026-10-28" });
    expect(item.sub.id).toBe("s1");
    /* A renewal is not money owed yet — "due" (and Payments' Owed to you) stay the real dues. */
    expect(rows[0].amountDue).toBe(0);
    expect(rows[0].renewalAmount).toBe(12000);
  });

  it("amount from the renewal quote when one exists (not est.)", () => {
    const rows = buildCollectionRows(input({
      renewals: [ren({ id: "s1", renewal_quote_id: "Q-R1" })],
      renewalQuotes: [{ id: "Q-R1", amount: 14160, status: "sent" }],
    }), TODAY);
    expect(rows[0].renewals[0]).toMatchObject({ kind: "renewal", amount: 14160, estimate: false, quoteId: "Q-R1", quoteHref: "/quotes/Q-R1" });
  });

  it("due in ≤7 days is listed; 8+ days out is not", () => {
    const rows = buildCollectionRows(input({
      renewals: [ren({ id: "soon", renewal_date: "2026-11-10" }), ren({ id: "later", renewal_date: "2026-11-11" })],
    }), TODAY);
    expect(rows.flatMap((r) => r.renewals.map((i) => i.id))).toEqual(["soon"]);
    expect(rows[0].renewals[0].daysOverdue).toBe(-7);
  });

  it("leaves out Won't renew, paid (renewed), cancelled, stopped and a flex month", () => {
    const rows = buildCollectionRows(input({
      renewals: [
        ren({ id: "wont", auto_renew: false }),
        ren({ id: "renewed", renewal_state: "renewed", renewal_date: "2027-10-28" }),   // paid: record_payment rolled the date a term on
        ren({ id: "cancelled", status: "cancelled" }),
        ren({ id: "stopped", status: "suspended", renewal_state: "suspended" }),
        ren({ id: "flex", term_months: 1, billing_cycle: "monthly", renewal_date: "2026-11-05" }),
        ren({ id: "keep" }),
      ],
    }), TODAY);
    expect(rows.flatMap((r) => r.renewals.map((i) => i.id))).toEqual(["keep"]);
  });

  it("no duplicate: a renewal whose quote already has an unpaid invoice stays as that invoice row only", () => {
    const rows = buildCollectionRows(input({
      invoices: [inv({ id: "INV-9", quote_id: "Q-R1" })],
      renewals: [ren({ id: "s1", renewal_quote_id: "Q-R1" })],
      renewalQuotes: [{ id: "Q-R1", amount: 14160, status: "accepted" }],
    }), TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0].items.map((i) => `${i.kind}:${i.id}`)).toEqual(["invoice:INV-9"]);
    expect(rows[0].renewals).toEqual([]);
  });

  it("sorted with the rest by urgency (most overdue first)", () => {
    const rows = buildCollectionRows(input({
      invoices: [inv({ id: "INV-NEW", customer_id: "c2", customer_name: "SEOAK", due_date: "2026-11-01" })],
      renewals: [ren({ id: "s1", renewal_date: "2026-10-20" })],
    }), TODAY);
    expect(rows.map((r) => r.customerId)).toEqual(["c1", "c2"]);
  });

  it("a renewal joins the customer's existing row next to their invoice", () => {
    const rows = buildCollectionRows(input({
      invoices: [inv({ id: "INV-1", due_date: "2026-10-01" })],
      renewals: [ren({ id: "s1" })],
    }), TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0].items.map((i) => i.id)).toEqual(["INV-1"]);
    expect(rows[0].renewals.map((i) => i.id)).toEqual(["s1"]);
    expect(rows[0].amountDue).toBe(14160);
  });

  it("receivables (Payments → Owed to you) never count a renewal", () => {
    expect(receivableLines({ invoices: [], subscriptions: [], invoicedQuoteIds: new Set() })).toEqual([]);
  });

  it("fetchCollectionsInput reads the due renewals and their renewal quotes", async () => {
    const fetched = await fetchCollectionsInput(fakeSupabase({
      invoices: [], payment_followups: [],
      subscriptions: [
        ren({ id: "s1", renewal_quote_id: "Q-R1" }) as unknown as Row,
        ren({ id: "far", renewal_date: "2099-01-01" }) as unknown as Row,
      ],
      quotes: [{ id: "Q-R1", amount: 14160, status: "sent" }],
      customers: [{ id: "c1", name: "REDOQ", display_name: null, account_manager_id: null }],
    }) as never);
    expect(fetched.renewals?.map((s) => s.id)).toEqual(["s1"]);
    expect(fetched.renewalQuotes?.map((q) => q.id)).toEqual(["Q-R1"]);
    expect(fetched.customers.map((c) => c.id)).toEqual(["c1"]);
  });
});

type Row = Record<string, unknown>;
function fakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const q = {
        select: () => q,
        in: (col: string, vals: unknown[]) => { rows = rows.filter((r) => vals.includes(r[col])); return q; },
        gt: (col: string, v: number) => { rows = rows.filter((r) => Number(r[col]) > v); return q; },
        lte: (col: string, v: string) => { rows = rows.filter((r) => r[col] != null && String(r[col]) <= v); return q; },
        neq: (col: string, v: unknown) => { rows = rows.filter((r) => r[col] !== v); return q; },
        eq: (col: string, v: unknown) => { rows = rows.filter((r) => r[col] === v); return q; },
        is: (col: string, v: null) => { rows = rows.filter((r) => (r[col] ?? null) === v); return q; },
        order: () => q,
        range: (from: number, to: number) =>
          Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null }),
      };
      return q;
    },
  };
}
