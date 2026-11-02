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
  buyPageTenantIdOrEmpty: () => "00000000-0000-0000-0000-000000002355",
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
    orders = { create: async (o: Record<string, unknown>) => { db.orders.push(o); return { id: "order_R2355" }; } };
  },
}));

import { checkoutBody, EMPTY_BUYER, EMPTY_DOMAIN } from "@/app/(public)/buy/workspace/_parts/checkout-form";
import type { BuyPlan } from "@/app/(public)/buy/workspace/_parts/plans";

const STANDARD_ROW = {
  id: "GW-STD", name: "Google Workspace Business Standard", msrp: 1080, wholesale: 0,
  prices: { annual: { msrp: 1080, wholesale: 0 }, monthly: { msrp: 1300, wholesale: 0 } },
};
const AVAILABLE = {
  ok: true, base: "ravitraders", source: "resellerclub",
  domains: [{ domain: "ravitraders.in", available: true, price: 649, currency: "INR", years: 1, priceKnown: true, prices: { "1": 649 } }],
};

/** Exactly what the desktop checkout's Pay builds (checkout.tsx → checkoutBody) after step 2. */
function desktopBody(billing: "annual" | "monthly") {
  return checkoutBody({
    plan: { id: "standard" } as BuyPlan, seats: 2, billing,
    domain: { ...EMPTY_DOMAIN, mode: "new", newName: "ravitraders", picked: { domain: "ravitraders.in", price: 649, testPrice: false } },
    buyer: { ...EMPTY_BUYER, name: "Ravi Kumar", company: "Ravi Traders", email: "ravi@example.invalid", phone: "9811122233", stateCode: "07", addressLine1: "12 Main Road, Rohini", city: "New Delhi", pinCode: "110085" },
    couponCode: null, simulate: true,
  });
}

const ENV = { ...process.env };
async function post(body: Record<string, unknown>) {
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  delete process.env.TURNSTILE_SECRET_KEY;
  vi.resetModules();
  const { POST } = await import("./route");
  return POST(new NextRequest("https://example.invalid/api/public/checkout/workspace", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}
type Row = Record<string, unknown> & { line_items: Record<string, unknown>[] };
const quotes = () => db.inserts.filter((i) => i.table === "quotes").map((i) => i.row as Row);

beforeEach(() => {
  db.catalogRow = STANDARD_ROW; db.inserts = []; db.updates = []; db.rpcs = []; db.docNo = 0;
  db.lookup = AVAILABLE; db.orders = []; db.invoices = [];
});
afterEach(() => { process.env = { ...ENV }; });

/**
 * R-2355 (2 Nov 2026): the desktop checkout's Monthly + new domain order. Before the fix its body
 * had no address (checkoutBody sent it on Annual only) and this route answered 400 needAddress —
 * the buyer had typed the address in step 2 and the order was still refused.
 */
describe("R-2355 desktop Monthly + new domain body is accepted by the route", { timeout: 60_000 }, () => {
  it("monthly: 200, two quotes (Workspace ₹3,068 + domain ₹766), the registrant carries the address", async () => {
    const res = await post(desktopBody("monthly"));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.needAddress).toBeUndefined();
    expect(res.status).toBe(200);
    expect(quotes()).toHaveLength(2);
    expect(quotes()[0]).toMatchObject({ amount: 3068, billing_cycle: "monthly" });
    expect(quotes()[1]).toMatchObject({ subtotal: 649, amount: 766, domain: "ravitraders.in" });
    expect(quotes()[1].line_items[0].registrant).toMatchObject({ address: { line1: "12 Main Road, Rohini", city: "New Delhi", zipcode: "110085", state: "Delhi" } });
    expect(json.totalRupees).toBe(3834);
  });

  it("annual (unchanged): 200, the domain is a line in the one quote", async () => {
    const res = await post(desktopBody("annual"));
    expect(res.status).toBe(200);
    expect(quotes()).toHaveLength(1);
  });
});
