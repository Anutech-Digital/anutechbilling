/**
 * R-2852 — the Razorpay webhook finds EVERY subscription a paid renewal quote renews (rev-r2849 H1 / L3).
 * Before, `.eq("renewal_quote_id", quote.id).maybeSingle()` errored on a quote billed together (2+ rows),
 * logged "no subscription points at it" and queued no domain / hosting renewal.
 */
import { describe, it, expect } from "vitest";
import { renewedSubscriptionsOf, type RenewedReadClient } from "./renewed-subscriptions.server";

type Row = Record<string, unknown>;
function fakeAdmin(tables: Record<string, Row[]>, errors: Record<string, { code?: string; message: string }> = {}) {
  const reads: { table: string; filters: unknown[][] }[] = [];
  const from = (table: string) => ({
    select: () => {
      const read = { table, filters: [] as unknown[][] };
      reads.push(read);
      const rows = () => (tables[table] ?? []).filter((r) => read.filters.every(([op, c, v]) =>
        op === "eq" ? r[c as string] === v
          : op === "in" ? (v as unknown[]).includes(r[c as string])
            : op === "is" ? (r[c as string] ?? null) === v : true));
      const chain: Record<string, unknown> = {
        eq: (c: string, v: unknown) => { read.filters.push(["eq", c, v]); return chain; },
        in: (c: string, v: unknown[]) => { read.filters.push(["in", c, v]); return chain; },
        is: (c: string, v: null) => { read.filters.push(["is", c, v]); return chain; },
        limit: (n: number) => { read.filters.push(["limit", n]); return chain; },
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
          Promise.resolve(errors[table] ? { data: null, error: errors[table] } : { data: rows(), error: null }).then(ok, ko),
      };
      return chain;
    },
  });
  return { admin: { from } as unknown as RenewedReadClient, reads };
}

const T = "ten-1";
const quote = { id: "Q-T1", tenant_id: T, tax_rate: 18 };

describe("R-2852 renewedSubscriptionsOf", () => {
  it("together quote: every live member, found by its renewal_quote_subscriptions rows — no false error", async () => {
    const { admin } = fakeAdmin({
      renewal_quote_subscriptions: [
        { tenant_id: T, quote_id: "Q-T1", subscription_id: "s1", subtotal: 100000, released_at: null },
        { tenant_id: T, quote_id: "Q-T1", subscription_id: "s2", subtotal: 50000, released_at: null },
        { tenant_id: T, quote_id: "Q-T1", subscription_id: "s9", subtotal: 1, released_at: "2026-11-01" },
      ],
      subscriptions: [
        { id: "s1", tenant_id: T, vendor: "google", domain: "acme.in", renewal_quote_id: "Q-T1" },
        { id: "s2", tenant_id: T, vendor: "google", domain: "acme.in", renewal_quote_id: "Q-T1" },
        { id: "s9", tenant_id: T, vendor: "domain", domain: "acme.in", renewal_quote_id: null },
      ],
    });
    const r = await renewedSubscriptionsOf(admin, quote);
    expect(r.together).toBe(true);
    expect(r.problem).toBeNull();
    expect(r.subs.map((s) => [s.id, s.vendor, s.share])).toEqual([["s1", "google", 118000], ["s2", "google", 59000]]);
  });

  it("an old together quote with a domain member: that member's own share (subtotal + GST), never the whole payment", async () => {
    const { admin } = fakeAdmin({
      renewal_quote_subscriptions: [
        { tenant_id: T, quote_id: "Q-T1", subscription_id: "s1", subtotal: 100000, released_at: null },
        { tenant_id: T, quote_id: "Q-T1", subscription_id: "d1", subtotal: 1000, released_at: null },
      ],
      subscriptions: [
        { id: "s1", tenant_id: T, vendor: "google", domain: "acme.in" },
        { id: "d1", tenant_id: T, vendor: "domain", domain: "Acme.in" },
      ],
    });
    const r = await renewedSubscriptionsOf(admin, quote);
    expect(r.subs.find((s) => s.id === "d1")).toMatchObject({ vendor: "domain", share: 1180 });
  });

  it("single quote: the one subscription linked to it, share = whole payment (unchanged)", async () => {
    const { admin, reads } = fakeAdmin({
      renewal_quote_subscriptions: [],
      subscriptions: [{ id: "s1", tenant_id: T, vendor: "domain", domain: "acme.in", renewal_quote_id: "Q-T1" }],
    });
    const r = await renewedSubscriptionsOf(admin, quote);
    expect(r).toMatchObject({ together: false, problem: null, subs: [{ id: "s1", vendor: "domain", domain: "acme.in", share: null }] });
    expect(r.subs).toHaveLength(1);
    expect(reads[1].filters).toContainEqual(["eq", "tenant_id", T]);
  });

  it("another company's link rows / subscriptions are never read as this quote's", async () => {
    const { admin } = fakeAdmin({
      renewal_quote_subscriptions: [{ tenant_id: "other", quote_id: "Q-T1", subscription_id: "x1", subtotal: 9, released_at: null }],
      subscriptions: [{ id: "x1", tenant_id: "other", vendor: "domain", domain: "x.in", renewal_quote_id: "Q-T1" }],
    });
    expect(await renewedSubscriptionsOf(admin, quote)).toEqual({ together: false, problem: null, subs: [] });
  });

  it("an older database without the table → single path, no error", async () => {
    for (const code of ["42P01", "PGRST205"]) {
      const { admin } = fakeAdmin(
        { subscriptions: [{ id: "s1", tenant_id: T, vendor: "hosting", domain: "acme.in", renewal_quote_id: "Q-T1" }] },
        { renewal_quote_subscriptions: { code, message: "missing" } },
      );
      const r = await renewedSubscriptionsOf(admin, quote);
      expect(r.subs.map((s) => s.id)).toEqual(["s1"]);
      expect(r.problem).toBeNull();
    }
  });

  it("two subscriptions on the link with no together rows (drift) or a read failure → nothing guessed, a problem named", async () => {
    const drift = fakeAdmin({
      subscriptions: [
        { id: "s1", tenant_id: T, vendor: "domain", domain: "a.in", renewal_quote_id: "Q-T1" },
        { id: "s2", tenant_id: T, vendor: "hosting", domain: "b.in", renewal_quote_id: "Q-T1" },
      ],
    });
    const r = await renewedSubscriptionsOf(drift.admin, quote);
    expect(r.subs).toEqual([]);
    expect(r.problem).toMatch(/more than one subscription points at it but it is not billed together/);

    const broken = fakeAdmin({}, { renewal_quote_subscriptions: { code: "57014", message: "timeout" } });
    const b = await renewedSubscriptionsOf(broken.admin, quote);
    expect(b.subs).toEqual([]);
    expect(b.problem).toMatch(/billed-together rows could not be read \(timeout\)/);
  });
});
