/**
 * R-1516 — /collections: the list, its order, broken promises, "Mere", the TDS hint and links.
 */
import { describe, it, expect } from "vitest";
import {
  buildCollectionRows, compareCollectionRows, defaultCollectionView, fetchCollectionsInput,
  filterCollectionRows, tdsHintRate,
  type CollectionFollowup, type CollectionInvoice, type CollectionRow, type CollectionsInput,
  type CollectionSubscription,
} from "@/lib/queries/collections";

const TODAY = "2026-10-17";

function inv(p: Partial<CollectionInvoice> & { id: string }): CollectionInvoice {
  return {
    customer_id: "c1", customer_name: "Acme", amount: 11800, net_payable: 11800, paid_amount: 0,
    status: "pending", invoice_date: "2026-09-01", due_date: "2026-09-16", quote_id: null,
    taxable_value: 10000, tax_amount: 1800, ...p,
  };
}
function sub(p: Partial<CollectionSubscription> & { id: string }): CollectionSubscription {
  return {
    customer_id: "c1", customer_name: "Acme", plan: "Workspace", domain: "acme.in", quote_id: null,
    outstanding_amount: 5000, payment_due_date: "2026-10-10", created_at: "2026-10-01T00:00:00Z", ...p,
  };
}
function fu(p: Partial<CollectionFollowup> & { id: string }): CollectionFollowup {
  return {
    customer_id: "c1", kind: "call", note: null, promised_amount: null, promised_on: null,
    next_follow_up_on: null, assigned_to: null, created_at: "2026-10-10T10:00:00Z", ...p,
  };
}
function input(p: Partial<CollectionsInput> = {}): CollectionsInput {
  return {
    invoices: [], subscriptions: [], quoteSubscriptions: [], invoicedQuoteIds: new Set(),
    customers: [
      { id: "c1", name: "Acme Pvt Ltd", display_name: null, account_manager_id: "u-sales" },
      { id: "c2", name: "Beta", display_name: null, account_manager_id: "u-other" },
      { id: "c3", name: "Gamma", display_name: null, account_manager_id: null },
    ],
    followups: [], ...p,
  };
}

describe("buildCollectionRows — what is owed (same rule as Aging / invoiceAmountDue)", () => {
  it("one row per customer; balance = net_payable − paid; paid/void/draft and settled invoices dropped", () => {
    const rows = buildCollectionRows(input({
      invoices: [
        inv({ id: "INV-1", net_payable: 11800, paid_amount: 1800 }),
        inv({ id: "INV-2", amount: 5900, net_payable: null, taxable_value: 5000, tax_amount: 900 }),
        inv({ id: "INV-3", status: "paid" }),
        inv({ id: "INV-4", status: "void" }),
        inv({ id: "INV-5", status: "draft" }),
        inv({ id: "INV-6", paid_amount: 11800 }),
      ],
    }), TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0].customerName).toBe("Acme Pvt Ltd");
    expect(rows[0].amountDue).toBe(10000 + 5900);
    expect(rows[0].items.map((i) => i.id).sort()).toEqual(["INV-1", "INV-2"]);
  });

  it("days overdue from the due date (IST), worst line wins", () => {
    const [r] = buildCollectionRows(input({
      invoices: [inv({ id: "A", due_date: "2026-10-07" }), inv({ id: "B", due_date: "2026-09-17" })],
    }), TODAY);
    expect(r.daysOverdue).toBe(30);
    expect(r.items[0].id).toBe("B");
  });

  it("a subscription balance counts only when its quote has no invoice (never twice)", () => {
    const rows = buildCollectionRows(input({
      subscriptions: [sub({ id: "s1", quote_id: "Q-1" }), sub({ id: "s2", quote_id: "Q-2", outstanding_amount: 700 })],
      invoicedQuoteIds: new Set(["Q-1"]),
    }), TODAY);
    expect(rows[0].amountDue).toBe(700);
    expect(rows[0].items[0]).toMatchObject({ kind: "subscription", id: "s2", quoteHref: "/quotes/Q-2" });
  });

  it("reads past 1000 rows: 2,500 invoices all land in the list", async () => {
    const many = Array.from({ length: 2500 }, (_, i) =>
      inv({ id: `INV-${String(i).padStart(5, "0")}`, customer_id: `c${i % 3 + 1}`, net_payable: 100, amount: 100, taxable_value: null, tax_amount: null }));
    const fetched = await fetchCollectionsInput(fakeSupabase({
      invoices: many as unknown as Row[], subscriptions: [], customers: input().customers as unknown as Row[], payment_followups: [],
    }) as never);
    expect(fetched.invoices).toHaveLength(2500);
    const rows = buildCollectionRows(fetched, TODAY);
    expect(rows.reduce((s, r) => s + r.amountDue, 0)).toBe(250_000);
    expect(rows.reduce((s, r) => s + r.items.length, 0)).toBe(2500);
  });
});

describe("follow-ups: promise, next follow-up, owner", () => {
  it("newest row gives next follow-up + note; newest promise row gives the promise; broken when past and owed", () => {
    const [r] = buildCollectionRows(input({
      invoices: [inv({ id: "INV-1" })],
      followups: [
        fu({ id: "f1", kind: "promise", promised_on: "2026-10-15", promised_amount: 11800, created_at: "2026-10-05T00:00:00Z" }),
        fu({ id: "f2", note: "Call again", next_follow_up_on: "2026-10-20", assigned_to: "u-me", created_at: "2026-10-12T00:00:00Z" }),
      ],
    }), TODAY);
    expect(r).toMatchObject({
      promisedOn: "2026-10-15", promisedAmount: 11800, promiseBroken: true,
      nextFollowUpOn: "2026-10-20", followUpDue: false, lastNote: "Call again", assignedTo: "u-me", ownerId: "u-sales",
    });
  });

  it("a promise for today or later is not broken", () => {
    const [r] = buildCollectionRows(input({
      invoices: [inv({ id: "INV-1" })],
      followups: [fu({ id: "f1", kind: "promise", promised_on: TODAY })],
    }), TODAY);
    expect(r.promiseBroken).toBe(false);
  });
});

describe("sort order", () => {
  it("follow-up due today / broken promise first, then most overdue, then biggest", () => {
    const rows = buildCollectionRows(input({
      invoices: [
        inv({ id: "OLD", customer_id: "c2", customer_name: "Beta", due_date: "2026-06-01", net_payable: 100 }),
        inv({ id: "TODAY", customer_id: "c1", due_date: "2026-10-16", net_payable: 50 }),
        inv({ id: "BIG", customer_id: "c3", customer_name: "Gamma", due_date: "2026-06-01", net_payable: 9999 }),
      ],
      followups: [fu({ id: "f", customer_id: "c1", next_follow_up_on: TODAY })],
    }), TODAY);
    expect(rows.map((r) => r.customerId)).toEqual(["c1", "c3", "c2"]);
  });

  it("is a total order (equal rows fall back to name)", () => {
    const base = { followUpDue: false, promiseBroken: false, daysOverdue: 5, amountDue: 10 } as CollectionRow;
    expect(compareCollectionRows({ ...base, customerName: "A" }, { ...base, customerName: "B" })).toBeLessThan(0);
  });
});

describe("filters", () => {
  const rows = buildCollectionRows(input({
    invoices: [
      inv({ id: "1", customer_id: "c1" }),
      inv({ id: "2", customer_id: "c2", customer_name: "Beta" }),
      inv({ id: "3", customer_id: "c3", customer_name: "Gamma" }),
    ],
    followups: [
      fu({ id: "f", customer_id: "c3", assigned_to: "u-sales" }),
      fu({ id: "g", customer_id: "c2", kind: "promise", promised_on: "2026-10-01" }),
    ],
  }), TODAY);

  it("Mere = my customers (owner) or follow-ups handed to me", () => {
    expect(filterCollectionRows(rows, "mine", "u-sales").map((r) => r.customerId).sort()).toEqual(["c1", "c3"]);
    expect(filterCollectionRows(rows, "mine", null)).toEqual([]);
  });
  it("Broken promises", () => {
    expect(filterCollectionRows(rows, "broken", "u-sales").map((r) => r.customerId)).toEqual(["c2"]);
  });
  it("All", () => {
    expect(filterCollectionRows(rows, "all", "u-sales")).toHaveLength(3);
  });
  it("sales starts on Mere, others on All", () => {
    expect(defaultCollectionView("sales")).toBe("mine");
    expect(defaultCollectionView("sales_senior")).toBe("mine");
    expect(defaultCollectionView("owner")).toBe("all");
    expect(defaultCollectionView("accountant")).toBe("all");
  });
});

describe("TDS hint", () => {
  it("INV-A378: ₹25,500 left on ₹2,55,000 pre-GST = 10%", () => {
    expect(tdsHintRate(inv({ id: "INV-A378", amount: 300900, net_payable: 300900, taxable_value: 255000, tax_amount: 45900, paid_amount: 275400 }))).toBe(10);
  });
  it("2% (±₹1 rounding), pre-GST from amount − tax when taxable_value is missing", () => {
    expect(tdsHintRate(inv({ id: "x", amount: 11800, net_payable: 11800, taxable_value: null, tax_amount: 1800, paid_amount: 11601 }))).toBe(2);
  });
  it("no hint for any other balance, or with no pre-GST value", () => {
    expect(tdsHintRate(inv({ id: "x", paid_amount: 5000 }))).toBeNull();
    expect(tdsHintRate(inv({ id: "x", taxable_value: null, tax_amount: null, paid_amount: 10800 }))).toBeNull();
    expect(tdsHintRate(inv({ id: "x", status: "paid", paid_amount: 10800 }))).toBeNull();
  });
});

describe("links", () => {
  it("customer, invoice (encoded), quote and subscription hrefs", () => {
    const [r] = buildCollectionRows(input({
      invoices: [inv({ id: "ANU/26-27/001", quote_id: "Q-9" })],
      quoteSubscriptions: [sub({ id: "s9", quote_id: "Q-9", domain: "acme.in" })],
    }), TODAY);
    expect(r.customerHref).toBe("/customers/c1");
    expect(r.items[0]).toMatchObject({
      href: "/invoices/ANU%2F26-27%2F001",
      quoteHref: "/quotes/Q-9",
      subscriptionHref: "/subscriptions?q=acme.in",
    });
  });
  it("an invoice with no customer id has no customer link", () => {
    const [r] = buildCollectionRows(input({ invoices: [inv({ id: "1", customer_id: null, customer_name: "Walk-in" })] }), TODAY);
    expect(r).toMatchObject({ customerHref: null, customerName: "Walk-in" });
  });
});

// ─── A PostgREST stand-in that, like the real one, never answers more than 1000 rows ──
type Row = Record<string, unknown>;
function fakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const q = {
        select: () => q,
        in: (col: string, vals: unknown[]) => { rows = rows.filter((r) => vals.includes(r[col])); return q; },
        gt: (col: string, v: number) => { rows = rows.filter((r) => Number(r[col]) > v); return q; },
        is: (col: string, v: null) => { rows = rows.filter((r) => (r[col] ?? null) === v); return q; },
        order: () => q,
        range: (from: number, to: number) =>
          Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null }),
      };
      return q;
    },
  };
}
