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
      term: "Annual · billed yearly", renewalDate: "2027-04-01",
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
  function fakeClient(billings: { subscription_id: string }[], subs: LinkedSubscriptionRow[]) {
    const orArg: string[] = [];
    const from = vi.fn((table: string) => {
      if (table === "subscription_billings") {
        const q = { select: () => q, eq: () => q, limit: async () => ({ data: billings, error: null }) };
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
    return { client: { from } as never, from, orArg };
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
    expect(f.from).toHaveBeenCalledTimes(1);
  });
});
