/**
 * R-1985 (Pardeep, 26 Oct 2026): a MONTHLY (flex) Workspace order with "I need a new domain" is
 * paid in ONE payment, and the domain gets its OWN GST invoice ("usi payment me, alag invoice").
 *
 * Option A: the route raises TWO quotes —
 *   Q1  the Workspace flex quote, exactly as a monthly order without a domain (its month-1 invoice
 *       is the subscription instalment, R-1974 — untouched);
 *   Q2  the domain quote: one domain line with the registrant, priced HERE from the live registry
 *       (priceDomainLines, never a browser price), invoiced by generate_invoice like a cart domain.
 * ONE Razorpay order for the sum; its notes name both quotes and their shares, and both quotes
 * carry the order id, so the webhook can split the one payment into two payments rows. A
 * simulated order records both shares itself. The coupon / site promo touch the Workspace only.
 *
 * Owner's numbers: Standard monthly ₹1,300 × 2 users = ₹2,600 + ₹468 = ₹3,068; domain ₹649 +
 * ₹117 = ₹766; one payment ₹3,834.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  catalogRow: null as unknown,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; patch: Record<string, unknown>; eq: Record<string, unknown> }[],
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  docNo: 0,
  lookup: null as unknown,
  orders: [] as Record<string, unknown>[],
  invoices: [] as string[],
}));

function chain(table: string) {
  let pendingUpdate: { patch: Record<string, unknown>; eq: Record<string, unknown> } | null = null;
  let lastInsert: Record<string, unknown> | null = null;
  const result = () => {
    if (table === "items") return { data: db.catalogRow, error: null };
    if (table === "quotes") return { data: { public_token: `tok-${String(lastInsert?.id ?? "x")}` }, error: null };
    return { data: null, error: null };
  };
  const c: Record<string, unknown> = {};
  for (const m of ["select", "ilike", "limit", "lte", "or", "order", "abortSignal", "in"]) c[m] = () => c;
  c.eq = (k: string, v: unknown) => { if (pendingUpdate) pendingUpdate.eq[k] = v; return c; };
  c.update = (patch: Record<string, unknown>) => {
    pendingUpdate = { patch, eq: {} };
    db.updates.push({ table, ...pendingUpdate });
    return c;
  };
  c.insert = (row: Record<string, unknown>) => { lastInsert = row; db.inserts.push({ table, row }); return c; };
  c.maybeSingle = async () => result();
  c.single = async () => result();
  c.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
  return c;
}

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => chain(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpcs.push({ fn, args });
      if (fn === "next_document_number") return { data: `Q-T-000${++db.docNo}`, error: null };
      if (fn === "record_payment") return { data: { payment_id: "p" }, error: null };
      return { data: null, error: null };
    },
  }),
}));
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: () => null }));
vi.mock("@/lib/marketing/utm", () => ({ captureFromRequest: () => ({}) }));
vi.mock("@/lib/checkout/live-guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/checkout/live-guards")>()),
  buyPageTenantIdOrEmpty: () => "00000000-0000-0000-0000-000000001985",
  simulatedPaymentAllowed: () => true,
}));
vi.mock("@/lib/domains/live-lookup", async (orig) => ({
  ...(await orig<typeof import("@/lib/domains/live-lookup")>()),
  lookupDomains: async () => db.lookup,
}));
vi.mock("@/lib/checkout/online-invoice.server", () => ({
  issueInvoiceForOnlinePayment: vi.fn(async (_a: unknown, args: { quoteId: string }) => {
    db.invoices.push(args.quoteId);
    return { status: "issued", invoiceId: `INV-${args.quoteId}` };
  }),
}));
vi.mock("@/lib/meta/capi.server", () => ({ reportPurchaseToMeta: vi.fn(async () => undefined) }));
vi.mock("@/lib/email/owner-alert.server", () => ({
  loadOwnerAlert: async () => ({ alert: { ok: false, reason: "test" }, tenant: null }),
}));
vi.mock("@/lib/email/lead-owner.server", () => ({ loadLeadOwner: async () => null }));
vi.mock("@/lib/messaging", () => ({ sendCustomerEmail: vi.fn(async () => ({})), sendInternalEmail: vi.fn(async () => ({})) }));
vi.mock("razorpay", () => ({
  default: class {
    orders = { create: async (o: Record<string, unknown>) => { db.orders.push(o); return { id: "order_R1985" }; } };
  },
}));

const STANDARD_ROW = {
  id: "GW-STD", name: "Google Workspace Business Standard", msrp: 1080, wholesale: 0,
  prices: { annual: { msrp: 1080, wholesale: 0 }, monthly: { msrp: 1300, wholesale: 0 } },
};
const AVAILABLE = {
  ok: true, base: "ravitraders", source: "resellerclub",
  domains: [{ domain: "ravitraders.in", available: true, price: 649, currency: "INR", years: 1, priceKnown: true, prices: { "1": 649 } }],
};
const ADDRESS = { addressLine1: "12 Main Road, Rohini", city: "New Delhi", pinCode: "110085" };

const ENV = { ...process.env };
async function post(extra: Record<string, unknown>, live = false) {
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  delete process.env.TURNSTILE_SECRET_KEY;
  if (live) { process.env.RAZORPAY_KEY_ID = "rzp_test_r1985"; process.env.RAZORPAY_KEY_SECRET = "s3cret"; }
  vi.resetModules();
  const { POST } = await import("./route");
  return POST(new NextRequest("https://example.invalid/api/public/checkout/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fullName: "Ravi Kumar", companyName: "Ravi Traders", email: "ravi@example.invalid", phone: "+91 98111 22233",
      seats: 2, domain: "ravitraders.in", tierId: "standard", stateCode: "07", commitment: "monthly",
      simulate: !live, ...extra,
    }),
  }));
}
type Row = Record<string, unknown> & { line_items: Record<string, unknown>[] };
const quotes = () => db.inserts.filter((i) => i.table === "quotes").map((i) => i.row as Row);
const payments = () => db.rpcs.filter((r) => r.fn === "record_payment").map((r) => r.args);

beforeEach(() => {
  db.catalogRow = STANDARD_ROW; db.inserts = []; db.updates = []; db.rpcs = []; db.docNo = 0;
  db.lookup = AVAILABLE; db.orders = []; db.invoices = [];
});
afterEach(() => { process.env = { ...ENV }; });

describe("R-1985 monthly Workspace + new domain: one payment, two quotes, two invoices", { timeout: 60_000 }, () => {
  it("raises Q1 (Workspace flex, unchanged) and Q2 (the domain, its own quote)", async () => {
    const res = await post({ domainNew: true, ...ADDRESS });
    expect(res.status).toBe(200);
    const [q1, q2] = quotes();
    expect(quotes()).toHaveLength(2);
    // Q1 — exactly the monthly order without a domain.
    expect(q1).toMatchObject({ id: "Q-T-0001", subtotal: 2600, amount: 3068, billing_cycle: "monthly", seats: 2 });
    expect(q1.line_items).toHaveLength(1);
    expect(q1.line_items[0]).toMatchObject({ qty: 2, rate: 1300, commitment: "monthly" });
    // Q2 — the domain, priced on the server, with the registrant, on the SAME lead.
    expect(q2).toMatchObject({ id: "Q-T-0002", subtotal: 649, amount: 766, tax_rate: 18, lead_id: q1.lead_id, domain: "ravitraders.in" });
    expect(q2).not.toHaveProperty("billing_cycle");
    expect(q2.line_items).toHaveLength(1);
    expect(q2.line_items[0]).toMatchObject({ qty: 1, rate: 649, domain: "ravitraders.in", years: 1 });
    expect(q2.line_items[0]).not.toHaveProperty("commitment");
    expect(q2.line_items[0].registrant).toMatchObject({ firstName: "Ravi", email: "ravi@example.invalid", address: { state: "Delhi", zipcode: "110085" } });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.totalRupees).toBe(3834);
    expect(body.domainQuoteId).toBe("Q-T-0002");
    expect(body.newDomain).toMatchObject({ domain: "ravitraders.in", price: 649 });
  });

  it("simulated: ONE reference, two record_payment calls (3,068 on Q1, 766 on Q2), each quote invoiced", async () => {
    await post({ domainNew: true, ...ADDRESS });
    const p = payments();
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ p_quote_id: "Q-T-0001", p_amount: 3068, p_method: "razorpay" });
    expect(p[1]).toMatchObject({ p_quote_id: "Q-T-0002", p_amount: 766, p_method: "razorpay" });
    expect(p[1].p_reference).toBe(p[0].p_reference);
    expect(db.invoices).toEqual(["Q-T-0001", "Q-T-0002"]);
  });

  it("live: ONE Razorpay order for ₹3,834 — receipt Q1, notes name both quotes + shares; both quotes carry the order id", async () => {
    const res = await post({ domainNew: true, ...ADDRESS }, true);
    expect(res.status).toBe(200);
    expect(db.orders).toHaveLength(1);
    const o = db.orders[0] as { amount: number; receipt: string; notes: Record<string, string> };
    expect(o.amount).toBe(383400);
    expect(o.receipt).toBe("Q-T-0001");
    expect(o.notes).toMatchObject({ quoteId: "Q-T-0001", splitQuoteIds: "Q-T-0001,Q-T-0002", splitShares: "3068,766" });
    const refs = db.updates.filter((u) => u.table === "quotes" && u.patch.payment_reference === "order_R1985").map((u) => u.eq.id);
    expect(refs.sort()).toEqual(["Q-T-0001", "Q-T-0002"]);
    expect(payments()).toHaveLength(0); // the webhook records the money, not the route
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.amount).toBe(383400);
    expect(body.totalRupees).toBe(3834);
  });

  it("a domain price from the browser is ignored — the live lookup decides", async () => {
    await post({ domainNew: true, ...ADDRESS, domainPrice: 1, rate: 1 });
    expect(quotes()[1]).toMatchObject({ subtotal: 649, amount: 766 });
  });

  it("the domain is unavailable → refused, nothing saved", async () => {
    db.lookup = { ...AVAILABLE, domains: [{ ...AVAILABLE.domains[0], available: false, priceKnown: false, price: 0 }] };
    const res = await post({ domainNew: true, ...ADDRESS });
    expect(res.status).toBe(400);
    expect(db.inserts).toHaveLength(0);
  });

  it("no postal address → asked for it, nothing saved", async () => {
    const res = await post({ domainNew: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { needAddress?: boolean }).needAddress).toBe(true);
    expect(db.inserts).toHaveLength(0);
  });

  it("monthly WITHOUT a new domain is unchanged: one quote, one payment of ₹3,068", async () => {
    await post({});
    expect(quotes()).toHaveLength(1);
    expect(quotes()[0]).toMatchObject({ amount: 3068 });
    expect(payments()).toHaveLength(1);
    expect(payments()[0]).toMatchObject({ p_quote_id: "Q-T-0001", p_amount: 3068 });
  });

  it("the lead note says the domain is bought with this order on its own invoice (not 'bill it separately')", async () => {
    await post({ domainNew: true, ...ADDRESS });
    const lead = db.inserts.find((i) => i.table === "leads")?.row as Record<string, unknown>;
    expect(String(lead.notes)).toMatch(/ravitraders\.in — NEW: bought with this order, on its own GST invoice/);
    expect(String(lead.notes)).not.toMatch(/separately/);
    expect(String(lead.notes)).toContain("₹3,834");
  });
});
