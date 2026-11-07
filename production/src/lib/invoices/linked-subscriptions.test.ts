/**
 * R-1433: the invoice page finds the subscription(s) its invoice belongs to — by quote (new or
 * renewal) and by instalment — and shows plan, term, renewal date and a drawer link.
 */
import { describe, it, expect, vi } from "vitest";
import {
  linkedSubscriptionsFilter, linkedSubscriptionView, fetchInvoiceSubscriptions, type LinkedSubscriptionRow,
} from "./linked-subscriptions";
import { subscriptionOpenHref, openSubscriptionIdFromSearch } from "@/app/(app)/subscriptions/open-link";

const Q = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";

const row: LinkedSubscriptionRow = {
  id: S, plan: "Business Starter", domain: "acme.in", customer_name: "Acme", status: "active",
  billing_cycle: "annual", term_months: 12, start_date: "2026-04-01", renewal_date: "2027-04-01", seats: 5,
};

describe("linkedSubscriptionsFilter", () => {
  it("looks up by new quote, renewal quote and instalment, deduped", () => {
    expect(linkedSubscriptionsFilter([Q, Q, null], [S])).toBe(
      `quote_id.in.(${Q}),renewal_quote_id.in.(${Q}),id.in.(${S})`,
    );
  });
  it("nothing to look up → empty (no query, no card)", () => {
    expect(linkedSubscriptionsFilter([null, undefined, ""], [])).toBe("");
  });
  it("drops anything that is not an id (no filter injection)", () => {
    expect(linkedSubscriptionsFilter(["x),id.neq.(0"], [])).toBe("");
  });
});

describe("linkedSubscriptionView", () => {
  it("plan, status, term, renewal date and the drawer link", () => {
    expect(linkedSubscriptionView(row)).toEqual({
      id: S, plan: "Business Starter", subtitle: "acme.in", status: "Active",
      term: "Annual · paid yearly", renewalDate: "2027-04-01",
      href: `/subscriptions?open=${S}&q=acme.in`,
    });
  });
  it("no domain → the customer tells it apart", () => {
    expect(linkedSubscriptionView({ ...row, domain: null }).subtitle).toBe("Acme");
  });
});

describe("open-link", () => {
  it("round-trips the id; a bad id opens nothing", () => {
    expect(openSubscriptionIdFromSearch(subscriptionOpenHref(row).split("?")[1])).toBe(S);
    expect(openSubscriptionIdFromSearch("?open=nope")).toBe("");
    expect(openSubscriptionIdFromSearch("")).toBe("");
  });
});

describe("fetchInvoiceSubscriptions", () => {
  /** `billings` answer the invoice_id = invoice read; `credited` the credited_invoice_ids read (R-1717). */
  function fakeClient(billings: { subscription_id: string }[], subs: LinkedSubscriptionRow[], credited: { subscription_id: string }[] = []) {
    const orArg: string[] = [];
    const billingReads: string[] = [];
    const from = vi.fn((table: string) => {
      if (table === "subscription_billings") {
        let rows = billings;
        const q = {
          select: () => q,
          eq: (col: string, v: string) => { billingReads.push(`${col}=${v}`); rows = billings; return q; },
          contains: (col: string, v: string[]) => { billingReads.push(`${col}@>${v.join(",")}`); rows = credited; return q; },
          limit: async () => ({ data: rows, error: null }),
        };
        return q;
      }
      const q = {
        select: () => q,
        or: (f: string) => { orArg.push(f); return q; },
        order: () => q,
        limit: async () => ({ data: subs, error: null }),
      };
      return q;
    });
    return { client: { from } as never, from, orArg, billingReads };
  }

  it("instalment invoice with no quote still finds its subscription", async () => {
    const f = fakeClient([{ subscription_id: S }], [row]);
    const out = await fetchInvoiceSubscriptions(f.client, { invoiceId: "INV-1", quoteIds: [null] });
    expect(out).toEqual([row]);
    expect(f.orArg).toEqual([`id.in.(${S})`]);
  });

  it("an invoice with no quote and no instalment never queries subscriptions", async () => {
    const f = fakeClient([], []);
    expect(await fetchInvoiceSubscriptions(f.client, { invoiceId: "INV-2", quoteIds: [null, undefined] })).toEqual([]);
    expect(f.from).not.toHaveBeenCalledWith("subscriptions");
  });

  /* R-1717 (local data, 7 Nov): INV-F588-27-0049 — the Q1 part of two subscriptions, credited and
     re-raised as INV-F588-27-0050. The part's invoice_id moved to the new invoice and the old one
     is only in credited_invoice_ids, so the old invoice's page lost its subscription link. */
  it("a credited (replaced) part invoice still finds its subscriptions", async () => {
    const S2 = "33333333-3333-4333-8333-333333333333";
    const f = fakeClient([], [row], [{ subscription_id: S }, { subscription_id: S2 }, { subscription_id: S }]);
    const out = await fetchInvoiceSubscriptions(f.client, { invoiceId: "INV-F588-27-0049", quoteIds: [null] });
    expect(out).toEqual([row]);
    expect(f.billingReads).toEqual(expect.arrayContaining(["invoice_id=INV-F588-27-0049", "credited_invoice_ids@>INV-F588-27-0049"]));
    expect(f.orArg).toEqual([`id.in.(${S},${S2})`]);
  });
});
