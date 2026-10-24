/**
 * Domain renewals (owner, 25 Sep 2026: live price at renewal, full price, no free renewal).
 */
import { describe, it, expect, vi } from "vitest";
import {
  createDomainRenewalQuote,
  DOMAIN_RENEWAL_PLAN,
  domainRenewalEnabled,
  domainSubscriptionInsert,
  domainSubscriptionsToCreate,
  expiryEpochSeconds,
  renewalCommandId,
  type DomainRenewalQuoteInput,
} from "./renewal";

describe("switch and ids", () => {
  it("only an exact 1 turns automatic renewal on", () => {
    expect(domainRenewalEnabled({})).toBe(false);
    for (const v of ["", "0", "true", " 1"]) expect(domainRenewalEnabled({ DOMAIN_RENEWAL_LIVE: v }), v).toBe(false);
    expect(domainRenewalEnabled({ DOMAIN_RENEWAL_LIVE: "1" })).toBe(true);
  });
  it("one command id per row per IST day, distinct from registration's", () => {
    expect(renewalCommandId("R1", new Date("2026-09-25T05:00:00Z"))).toBe("rsos-domrenew-R1-2026-09-25");
    expect(renewalCommandId("R1", new Date("2026-09-25T20:00:00Z"))).toBe("rsos-domrenew-R1-2026-09-26"); // IST, not UTC
  });
  it("reads DMS's expiry as epoch seconds, and refuses an unusable one", () => {
    expect(expiryEpochSeconds("2027-09-25T00:00:00.000Z")).toBe(1821830400);
    expect(expiryEpochSeconds(null)).toBeNull();
    expect(expiryEpochSeconds("not a date")).toBeNull();
  });
});

describe("at the sale: one yearly subscription per paid domain", () => {
  it("takes only the lines that name a domain, once each", () => {
    const rows = domainSubscriptionsToCreate([
      { name: "acme.in", domain: "Acme.in", rate: 749, qty: 1 },
      { name: "Starter hosting (billed yearly)", rate: 600, qty: 1, hostingPlan: "starter" },
      { name: "dup", domain: "acme.in", rate: 749, qty: 1 },
    ]);
    expect(rows).toEqual([{ domain: "acme.in", mrr: 62, years: 1 }]);
  });
  it("a domain free with yearly hosting still gets its subscription (mrr 0; the renewal is priced live, not from this)", () => {
    expect(domainSubscriptionsToCreate([{ name: "Domain free.in", domain: "free.in", rate: 0, qty: 1 }])).toEqual([{ domain: "free.in", mrr: 0, years: 1 }]);
  });
  it("the row: vendor domain, 12 months, renewing a year out, NOT tied to the sale's quote", () => {
    const ins = domainSubscriptionInsert({ tenantId: "T", customerId: "C", customerName: "Acme", row: { domain: "acme.in", mrr: 62 }, today: "2026-09-25" });
    expect(ins).toMatchObject({ vendor: "domain", domain: "acme.in", term_months: 12, start_date: "2026-09-25", renewal_date: "2027-09-25", status: "active", quote_id: null, seats: 1 });
  });
  /* R-156: a 3-year registration is paid for 3 years — its first renewal is 3 years out,
     and the money is spread over 36 months, not 12 (which would triple the MRR). */
  it("a 3-year domain renews 3 years out, MRR over 36 months", () => {
    const rows = domainSubscriptionsToCreate([{ name: "Domain long.in — registration, 3 years", domain: "long.in", rate: 2700, qty: 1, years: 3 }]);
    expect(rows).toEqual([{ domain: "long.in", mrr: 75, years: 3 }]);
    const ins = domainSubscriptionInsert({ tenantId: "T", customerId: "C", customerName: "Acme", row: rows[0], today: "2026-10-05" });
    expect(ins).toMatchObject({ renewal_date: "2029-10-05", term_months: 12, mrr: 75 });
  });
});

interface MadeArgs { p_subscription_id: string; p_tenant_id: string; p_quote: Record<string, unknown> & { line_items: unknown[] } }

/** A small fake of the admin client: records inserts/updates, answers create_renewal_quote. */
function fakeDb(opts: {
  existingQuote?: unknown;
  country?: string | null;
  /** What create_renewal_quote answers instead of "made it" (another run first / an error). */
  made?: { data: unknown; error: { message: string } | null };
} = {}) {
  const calls = { rpc: 0, made: [] as MadeArgs[], inserts: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[] };
  const q = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      select: self, eq: self,
      maybeSingle: async () => ({ data: table === "quotes" ? opts.existingQuote ?? null : table === "customers" ? { country: opts.country ?? "IN" } : null, error: null }),
      insert: async (row: Record<string, unknown>) => { calls.inserts.push(row); return { error: null }; },
      update: (row: Record<string, unknown>) => { calls.updates.push(row); return { eq: () => ({ eq: () => ({ select: async () => ({ data: [{ id: "S1" }], error: null }) }) }) }; },
    });
    return chain;
  };
  const db = {
    from: q,
    rpc: vi.fn(async (fn: string, args: MadeArgs) => {
      calls.rpc += 1;
      if (fn !== "create_renewal_quote") return { data: null, error: { message: `unexpected rpc ${fn}` } };
      calls.made.push(args);
      if (opts.made) return opts.made;
      const p = args.p_quote;
      return {
        data: { quote_id: "Q-DR-0001", created: true, relinked: false, amount: p.amount, subtotal: p.subtotal,
                discount_pct: 0, tax_rate: p.tax_rate, line_items: p.line_items },
        error: null,
      };
    }),
  };
  return { db: db as unknown as DomainRenewalQuoteInput["supabase"], calls };
}

const base = (db: DomainRenewalQuoteInput["supabase"]): DomainRenewalQuoteInput => ({
  supabase: db, subscriptionId: "S1", tenantId: "T", customerId: "C", customerName: "Acme",
  domain: "acme.in", renewalDate: "2027-09-25", graceDays: 7,
});

describe("the renewal quote is priced LIVE, at full price", () => {
  it("uses ResellerClub's renewal price for the extension, + 18% GST", async () => {
    const { db, calls } = fakeDb();
    const r = await createDomainRenewalQuote({ ...base(db), price: async () => ({ ok: true, rupees: 899 }) });
    expect(r).toMatchObject({ quoteId: "Q-DR-0001", subtotal: 899, amount: 1061, taxRate: 18, created: true });
    const quote = calls.made[0].p_quote;
    expect(quote).toMatchObject({ extension_months: 12, plan: DOMAIN_RENEWAL_PLAN, domain: "acme.in", amount: 1061 });
    expect(calls.made[0]).toMatchObject({ p_subscription_id: "S1", p_tenant_id: "T" });
  });

  it("the quote line names no domain — provisioning would read one as a domain to REGISTER", async () => {
    const { db, calls } = fakeDb();
    await createDomainRenewalQuote({ ...base(db), price: async () => ({ ok: true, rupees: 899 }) });
    const [line] = (calls.made[0].p_quote.line_items as { domain?: string; commitment?: string }[]);
    expect(line.domain).toBeUndefined();
    expect(line.commitment).toBe("annual_yearly");
  });

  it("the line keeps the subscription's own name, so paying it does not rename the subscription", async () => {
    const { db, calls } = fakeDb();
    await createDomainRenewalQuote({ ...base(db), price: async () => ({ ok: true, rupees: 899 }) });
    const [line] = (calls.made[0].p_quote.line_items as { name: string; description?: string }[]);
    const created = domainSubscriptionInsert({ tenantId: "T", customerId: "C", customerName: "Acme", row: { domain: "acme.in", mrr: 0 }, today: "2026-09-25" });
    expect(line.name).toBe(created.plan);
    expect(line.description).toBe("Renewal, 1 year");
  });

  it("price unreadable → no quote, and no document number spent", async () => {
    const { db, calls } = fakeDb();
    const r = await createDomainRenewalQuote({ ...base(db), price: async () => ({ ok: false, reason: "not reachable" }) });
    expect(r).toBeNull();
    expect(calls.rpc).toBe(0);
    expect(calls.inserts).toHaveLength(0);
  });

  it("an export customer is quoted with no GST", async () => {
    const { db } = fakeDb({ country: "US" });
    const r = await createDomainRenewalQuote({ ...base(db), price: async () => ({ ok: true, rupees: 899 }) });
    expect(r).toMatchObject({ amount: 899, taxRate: 0 });
  });

  it("an existing renewal quote is returned unchanged — the price is not re-read", async () => {
    const existing = { id: "Q-OLD", amount: 1000, subtotal: 847, discount_pct: 0, tax_rate: 18, line_items: [] };
    const { db, calls } = fakeDb({ existingQuote: existing });
    const price = vi.fn();
    const r = await createDomainRenewalQuote({ ...base(db), existingQuoteId: "Q-OLD", price });
    expect(r).toMatchObject({ quoteId: "Q-OLD", amount: 1000, created: false });
    expect(price).not.toHaveBeenCalled();
    expect(calls.rpc).toBe(0);
  });
});

describe("R-1574: made and linked in ONE call — never a quote insert + a separate link", () => {
  it("the quote is made only through create_renewal_quote; no direct insert or link update", async () => {
    const { db, calls } = fakeDb();
    await createDomainRenewalQuote({ ...base(db), price: async () => ({ ok: true, rupees: 899 }) });
    expect(calls.made).toHaveLength(1);
    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  it("another run made this term's quote first → that quote comes back, not the one priced now", async () => {
    const theirs = { quote_id: "Q-THEIRS", created: false, relinked: false, amount: 1000, subtotal: 847, discount_pct: 0, tax_rate: 18, line_items: [] };
    const { db } = fakeDb({ made: { data: theirs, error: null } });
    const r = await createDomainRenewalQuote({ ...base(db), price: async () => ({ ok: true, rupees: 899 }) });
    expect(r).toMatchObject({ quoteId: "Q-THEIRS", amount: 1000, subtotal: 847, created: false });
  });

  it("the RPC refuses → null (nothing half-made to clean up)", async () => {
    const { db } = fakeDb({ made: { data: null, error: { message: "belongs to another company" } } });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await createDomainRenewalQuote({ ...base(db), price: async () => ({ ok: true, rupees: 899 }) });
    expect(r).toBeNull();
    expect(err.mock.calls.flat().join(" ")).toContain("belongs to another company");
    err.mockRestore();
  });
});
