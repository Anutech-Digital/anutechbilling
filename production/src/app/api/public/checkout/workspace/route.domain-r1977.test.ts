/**
 * R-1977 (Pardeep, 26 Oct 2026): "I need a new domain" on /buy/workspace is a real domain
 * booking. The route prices the domain HERE, live (the same lookup + priceDomainLines as the
 * cart checkout) — a price from the browser is ignored. The quote gets a `domain:<tld>` style
 * line with the registrant (owner decision 22: in the customer's own name), so after payment
 * the same provisioning registers it. Unavailable → refused; lookup down → refused, nothing
 * saved (§24: the message names the next step). Workspace money is untouched; the domain is
 * never discounted by the site promo or the coupon; GST is on the whole taxable value.
 * Monthly (flex): R-1985 (owner decision) — the domain is charged in the same payment but on
 * its OWN quote and GST invoice (route.monthly-domain-r1985.test.ts); the Workspace quote stays
 * exactly the monthly order.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  catalogRow: null as unknown,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  lookup: null as unknown,
  lookups: [] as { name: string; tlds: readonly string[] }[],
}));

function chain(table: string) {
  const result = () => {
    if (table === "items") return { data: db.catalogRow, error: null };
    if (table === "quotes") return { data: { public_token: "tok-r1977" }, error: null };
    return { data: null, error: null };
  };
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "ilike", "limit", "lte", "or", "order", "update", "abortSignal"]) c[m] = () => c;
  c.insert = (row: Record<string, unknown>) => { db.inserts.push({ table, row }); return c; };
  c.maybeSingle = async () => result();
  c.single = async () => result();
  c.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
  return c;
}

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => chain(table),
    rpc: async (fn: string) =>
      fn === "next_document_number"
        ? { data: "Q-T-0001", error: null }
        : { data: null, error: { message: "stop after the quote", code: "P0001" } },
  }),
}));
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: () => null }));
vi.mock("@/lib/marketing/utm", () => ({ captureFromRequest: () => ({}) }));
vi.mock("@/lib/checkout/live-guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/checkout/live-guards")>()),
  buyPageTenantIdOrEmpty: () => "00000000-0000-0000-0000-000000001977",
  simulatedPaymentAllowed: () => true,
}));
vi.mock("@/lib/domains/live-lookup", async (orig) => ({
  ...(await orig<typeof import("@/lib/domains/live-lookup")>()),
  lookupDomains: async (name: string, tlds: readonly string[]) => { db.lookups.push({ name, tlds }); return db.lookup; },
}));

const STARTER_ROW = {
  id: "GW-STR", name: "Google Workspace Business Starter", msrp: 270, wholesale: 0,
  prices: { annual: { msrp: 270, wholesale: 0 }, monthly: { msrp: 325, wholesale: 0 } },
};
const AVAILABLE = {
  ok: true, base: "ravitraders", source: "resellerclub",
  domains: [{ domain: "ravitraders.in", available: true, price: 649, currency: "INR", years: 1, priceKnown: true, prices: { "1": 649 } }],
};
const ADDRESS = { addressLine1: "12 Main Road, Rohini", city: "New Delhi", pinCode: "110085" };

const ENV = { ...process.env };
async function post(extra: Record<string, unknown>) {
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  delete process.env.TURNSTILE_SECRET_KEY;
  vi.resetModules();
  const { POST } = await import("./route");
  return POST(new NextRequest("https://example.invalid/api/public/checkout/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fullName: "Ravi Kumar", companyName: "Ravi Traders", email: "Ravi@Example.invalid", phone: "+91 98111 22233",
      seats: 1, domain: "ravitraders.in", tierId: "starter", stateCode: "07", simulate: true, ...extra,
    }),
  }));
}
type Row = Record<string, unknown> & { line_items: Record<string, unknown>[] };
const quoteRow = () => db.inserts.find((i) => i.table === "quotes")?.row as Row;
const leadRow = () => db.inserts.find((i) => i.table === "leads")?.row as Record<string, unknown>;

beforeEach(() => { db.catalogRow = STARTER_ROW; db.inserts = []; db.lookup = AVAILABLE; db.lookups = []; });
afterEach(() => { process.env = { ...ENV }; });

describe("R-1977 new domain on the Workspace checkout", { timeout: 60_000 }, () => {
  it("Starter 1 user annual + ravitraders.in (live ₹649): ₹3,240 + ₹649 = ₹3,889 + GST ₹700 = ₹4,589; domain line with registrant", async () => {
    // (the mock stops at record_payment, after the quote row is written)
    await post({ domainNew: true, ...ADDRESS });
    expect(db.lookups).toEqual([{ name: "ravitraders", tlds: ["in"] }]);
    const q = quoteRow();
    expect(q.subtotal).toBe(3889);
    expect(q.amount).toBe(4589);
    expect(q.line_items).toHaveLength(2);
    // The Workspace line is untouched and first (the thanks page and the invoice read it first).
    expect(q.line_items[0]).toMatchObject({ qty: 1, rate: 3240, commitment: "annual_yearly" });
    const d = q.line_items[1];
    expect(d).toMatchObject({ qty: 1, rate: 649, domain: "ravitraders.in", years: 1 });
    expect(d).not.toHaveProperty("commitment");
    expect(d.registrant).toMatchObject({
      firstName: "Ravi", lastName: "Kumar", email: "ravi@example.invalid", phone: "9811122233", phoneCc: "91",
      companyName: "Ravi Traders",
      address: { line1: "12 Main Road, Rohini", city: "New Delhi", state: "Delhi", zipcode: "110085", country: "IN" },
    });
    expect(q.domain).toBe("ravitraders.in");
    expect(String(leadRow().notes)).toContain("ravitraders.in — NEW: bought with this order (₹649 + GST, 1 year)");
  });

  it("a domain price sent by the browser is ignored — the live lookup decides", async () => {
    await post({ domainNew: true, ...ADDRESS, domainPrice: 1, price: 1, rate: 1 });
    expect(quoteRow().line_items[1]).toMatchObject({ rate: 649 });
    expect(quoteRow().amount).toBe(4589);
  });

  it("the domain is no longer available → refused, nothing saved", async () => {
    db.lookup = { ...AVAILABLE, domains: [{ ...AVAILABLE.domains[0], available: false, priceKnown: false, price: 0 }] };
    const res = await post({ domainNew: true, ...ADDRESS });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; domainUnavailable?: boolean };
    expect(body.error).toMatch(/ravitraders\.in/);
    expect(body.error).toMatch(/no longer available/);
    expect(body.error).toMatch(/Nothing was charged/);
    expect(db.inserts).toHaveLength(0);
  });

  it("the registry can't be reached → refused with a next step, nothing saved", async () => {
    db.lookup = { ok: false };
    const res = await post({ domainNew: true, ...ADDRESS });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/couldn't reach the domain registry/);
    expect(body.error).toMatch(/try again|already have a domain/i);
    expect(db.inserts).toHaveLength(0);
  });

  it("no postal address → asked for it (the registry records the owner's address), nothing saved", async () => {
    const res = await post({ domainNew: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; needAddress?: boolean };
    expect(body.needAddress).toBe(true);
    expect(body.error).toMatch(/address/);
    expect(db.inserts).toHaveLength(0);
  });

  it("the coupon and site promo never discount the domain; GST is on the whole taxable value", async () => {
    // No promo / coupon rows in this mock — the domain line is added AFTER them in the route,
    // so its rate is the live price whatever the Workspace discounts were.
    await post({ domainNew: true, ...ADDRESS, seats: 10 });
    const q = quoteRow();
    expect(q.subtotal).toBe(32400 + 649);
    expect(q.amount).toBe(Math.round((32400 + 649) * 1.18));
  });

  it("an existing domain → no lookup, the order exactly as before (₹3,823)", async () => {
    await post({});
    expect(db.lookups).toHaveLength(0);
    expect(quoteRow().amount).toBe(3823);
    expect(quoteRow().line_items).toHaveLength(1);
  });

  it("Monthly (flex) + new domain → the Workspace quote is unchanged; the domain is priced live for its own quote (R-1985)", async () => {
    await post({ domainNew: true, ...ADDRESS, commitment: "monthly" });
    expect(db.lookups).toEqual([{ name: "ravitraders", tlds: ["in"] }]);
    const q = quoteRow();
    expect(q.amount).toBe(384); // 1 × ₹325 + GST ₹59 — unchanged monthly money
    expect(q.line_items).toHaveLength(1);
    expect(String(leadRow().notes)).toMatch(/ravitraders\.in — NEW: bought with this order, on its own GST invoice/);
    expect(String(leadRow().notes)).not.toMatch(/separately/);
  });

  it("a malformed new domain is refused before anything is saved", async () => {
    const res = await post({ domainNew: true, ...ADDRESS, domain: "sub.ravi.traders.in" });
    expect(res.status).toBe(400);
    expect(db.inserts).toHaveLength(0);
  });
});
