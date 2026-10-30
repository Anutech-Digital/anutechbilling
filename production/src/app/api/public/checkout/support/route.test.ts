/**
 * R-2083 — POST /api/public/checkout/support and what happens after the buyer pays.
 *
 * Pinned with a mocked database and a mocked Razorpay (the R-1596 verify harness):
 *  - the order is priced on the server from the plan + term — an amount in the body is ignored;
 *  - the line points at the company's own SUP catalogue row (vendor support → record_payment
 *    files a support subscription → trg_queue_support_sync; the SQL side is
 *    supabase/tests/r2083_support_checkout_outbox.test.sql);
 *  - monthly is a monthly line on a billing_cycle 'monthly' quote; Free / unknown plans refused;
 *  - billing_customer_id attaches only to the company's own active customer with that email;
 *    a customer already on a paid support plan is not sold a second one;
 *  - verify: the signature is checked, the payment recorded once (a second verify, or the
 *    webhook after it, records nothing), the GST invoice issued, nothing queued for
 *    provisioning, and the buyer's mail speaks about support — not Workspace DNS steps.
 */
import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/lib/automation/gate.server", () => ({
  automationState: async () => "on",
  cronTenants: async () => ({ on: [], dry: [] }),
  recordRun: async () => {},
  readJobRow: async () => null,
  ensureDefaultOnRow: async () => {},
  readTenantJobs: async () => [],
}));
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as { name: string; args: Row }[],
  rpcImpl: null as null | ((name: string, args: Row) => { data: unknown; error: unknown }),
}));

vi.mock("@/lib/supabase/server", () => {
  function query(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let lim = Infinity;
    let pendingUpdate: Row | null = null;
    const rows = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, lim);
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      /* "id.eq.X,customer_number.eq.X" — the only or() the route sends. */
      or: (expr: string) => {
        const parts = expr.split(",").map((p) => { const [c, , ...v] = p.split("."); return [c, v.join(".")] as const; });
        filters.push((r) => parts.some(([c, v]) => String(r[c] ?? "") === v));
        return q;
      },
      ilike: (c: string, pat: string) => {
        const needle = pat.replace(/%/g, "").toLowerCase();
        filters.push((r) => String(r[c] ?? "").toLowerCase().includes(needle));
        return q;
      },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return q; },
      not: () => q,
      order: () => q,
      limit: (n: number) => { lim = n; return q; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => {
        const r = rows()[0];
        return r ? { data: r, error: null } : { data: null, error: { message: "not found" } };
      },
      update: (patch: Row) => { pendingUpdate = patch; return q; },
      insert: (row: Row) => {
        const saved = { ...row, ...(table === "quotes" ? { public_token: `tok-${String(row.id)}` } : {}) };
        (db.tables[table] ??= []).push(saved);
        const done = { data: null, error: null };
        return {
          select: () => ({ single: async () => ({ data: saved, error: null }) }),
          then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(done).then(ok, bad),
        };
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        const matched = rows();
        if (pendingUpdate) { for (const r of matched) Object.assign(r, pendingUpdate); }
        return Promise.resolve({ data: pendingUpdate ? matched : rows(), error: null }).then(ok, bad);
      },
    };
    return q;
  }
  return {
    createAdminClient: () => ({
      from: (t: string) => query(t),
      rpc: async (name: string, args: Row) => {
        db.rpcCalls.push({ name, args });
        return db.rpcImpl ? db.rpcImpl(name, args) : { data: null, error: null };
      },
    }),
  };
});
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: (s: unknown) => s }));
vi.mock("@/lib/notifications/notify.server", () => ({ notifyTenantOwners: vi.fn(async () => undefined) }));
const sendEmail = vi.hoisted(() =>
  vi.fn(async (_msg: Record<string, unknown>) => ({ status: "stubbed", providerId: null, errorMessage: null, provider: "stub" })),
);
vi.mock("@/lib/email/send", () => ({ sendEmail }));
vi.mock("@/lib/email/owner-alert.server", () => ({
  loadOwnerAlert: async () => ({ alert: { ok: true, to: "owner@example.invalid" }, tenant: { name: "AITEST Seller" } }),
}));
vi.mock("@/lib/ai/autonomy.server", () => ({ loadAutonomyPolicy: async () => ({ modes: {} }) }));
const queueProvisioning = vi.hoisted(() => vi.fn(async () => "queued"));
vi.mock("@/lib/provisioning/provisioning.server", () => ({ queueProvisioning }));
vi.mock("@/lib/razorpay/fee-expense.server", () => ({ bookGatewayFeeExpense: vi.fn(async () => "booked") }));
vi.mock("@/lib/pdf/pdf-token", () => ({
  pdfDownloadUrl: (base: string, kind: string, id: string) => `${base}/api/pdf/${kind}/${id}?sig=test`,
}));

const rzp = vi.hoisted(() => ({
  payment: null as null | Row,
  orders: [] as Row[],
  fetched: [] as string[],
}));
vi.mock("razorpay", () => ({
  default: class {
    payments: { fetch: (id: string) => Promise<Row> };
    orders: { create: (o: Row) => Promise<Row> };
    constructor() {
      this.payments = {
        fetch: async (id: string) => {
          rzp.fetched.push(id);
          if (!rzp.payment || rzp.payment.id !== id) throw { statusCode: 400, error: { description: "no such payment" } };
          return rzp.payment;
        },
      };
      this.orders = {
        create: async (o: Row) => { rzp.orders.push(o); return { id: "order_AITEST2083", ...o }; },
      };
    }
  },
}));

import { POST } from "./route";
import { verifyCheckoutPayment } from "@/lib/checkout/verify-payment.server";
import { POST as webhook } from "@/app/api/webhooks/razorpay/route";
import { DEV_BUY_PAGE_TENANT_ID } from "@/lib/checkout/live-guards";

const TENANT = DEV_BUY_PAGE_TENANT_ID;
const T32 = TENANT.replace(/-/g, "");
const KEY_SECRET = "rzp_secret_aitest";
const WEBHOOK_SECRET = "whsec_aitest";
const QUOTE = "Q-AITEST-2083";
const ORDER = "order_AITEST2083";
const PAY = "pay_AITEST2083";
const CUST = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";

function seed() {
  db.tables = {
    tenant_secrets: [{
      tenant_id: TENANT, razorpay_key_id: "rzp_test_aitest", razorpay_key_secret: KEY_SECRET,
      razorpay_mode: "test", razorpay_webhook_secret: WEBHOOK_SECRET,
    }],
    items: [
      { id: `SUP-STANDARD-YR-${T32}`, tenant_id: TENANT, vendor: "support", is_active: true, sku: "SUP-STANDARD-YR", name: "Support Standard (Yearly)" },
      { id: `SUP-STANDARD-MO-${T32}`, tenant_id: TENANT, vendor: "support", is_active: true, sku: "SUP-STANDARD-MO", name: "Support Standard (Monthly)" },
      /* "Add to catalog" rows carry no sku — found by the id (findSupportSku). */
      { id: `SUP-ENTERPRISE-YR-${T32}`, tenant_id: TENANT, vendor: "support", is_active: true, sku: null, name: "Support Enterprise (Yearly)" },
      /* another company's row is never picked */
      { id: "SUP-ENTERPRISE-MO-other", tenant_id: "other-tenant", vendor: "support", is_active: true, sku: "SUP-ENTERPRISE-MO", name: "x" },
    ],
    customers: [
      { id: CUST, tenant_id: TENANT, name: "AITEST Desk Customer", contact_email: "Buyer@Example.invalid", customer_number: "C-0042", is_active: true },
    ],
    leads: [], quotes: [], payments: [], subscriptions: [], lead_activities: [],
  };
  db.rpcCalls = [];
  db.rpcImpl = (name, args) => {
    if (name === "next_document_number") return { data: QUOTE, error: null };
    const q = db.tables.quotes.find((r) => r.id === args.p_quote_id)!;
    if (name === "record_payment") {
      if (db.tables.payments.some((r) => r.quote_id === q.id && r.reference === args.p_reference && r.status === "received")) {
        return { data: { payment_id: "p1", already_recorded: true }, error: null };
      }
      db.tables.payments.push({ id: `p-${String(args.p_reference)}`, tenant_id: q.tenant_id, quote_id: q.id, reference: args.p_reference, status: "received", amount: args.p_amount });
      q.payment_status = "received";
      return { data: { payment_id: "p1" }, error: null };
    }
    if (name === "generate_invoice") {
      if (q.invoice_id) return { data: null, error: { code: "23505", message: "exists" } };
      q.invoice_id = "INV-AITEST-2083";
      q.payment_status = "invoiced";
      return { data: [{ invoice_id: "INV-AITEST-2083" }], error: null };
    }
    return { data: null, error: null };
  };
  rzp.payment = null;
  rzp.orders = [];
  rzp.fetched = [];
}

const BODY = {
  plan: "standard", term: "yearly", fullName: "AITEST Buyer", email: "buyer@example.invalid",
  phone: "9876543210", stateCode: "07",
};
const order = (body: Row) =>
  POST(new NextRequest("https://shop.example.invalid/api/public/checkout/support", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

const sign = (orderId: string, paymentId: string, secret = KEY_SECRET) =>
  crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
const verifyReq = () => new NextRequest("https://shop.example.invalid/api/public/checkout/verify", { method: "POST" });
const verify = (signature = sign(ORDER, PAY)) => verifyCheckoutPayment(verifyReq(), { orderId: ORDER, paymentId: PAY, signature });

const ENV = { ...process.env };
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://shop.example.invalid");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "");
  vi.stubEnv("CATALOG_FROM_DB", "");
  vi.stubEnv("BUY_PAGE_TENANT_ID", "");
  seed();
  sendEmail.mockClear();
  queueProvisioning.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
});

describe("R-2083 POST /api/public/checkout/support — the order", () => {
  it("Standard yearly = ₹9,996 + GST = ₹11,795, priced on the server; an amount in the body is ignored", async () => {
    const res = await order({ ...BODY, amount: 1, totalRupees: 1, price: 1, rate: 1, subtotal: 1 });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ orderId: ORDER, amount: 1179500, quoteId: QUOTE, publicToken: `tok-${QUOTE}`, razorpayKeyId: "rzp_test_aitest" });
    expect(JSON.stringify(j)).not.toContain(KEY_SECRET);
    expect(rzp.orders[0]).toMatchObject({ amount: 1179500, currency: "INR", receipt: QUOTE });
    const q = db.tables.quotes[0];
    expect(q).toMatchObject({ amount: 11795, subtotal: 9996, tax_rate: 18, plan: "support-standard", payment_status: "awaiting", payment_reference: ORDER, customer_id: null });
    expect(q.billing_cycle).toBeUndefined();
    expect(q.line_items).toEqual([expect.objectContaining({
      item_id: `SUP-STANDARD-YR-${T32}`, name: "Support Standard (Yearly)", qty: 1, rate: 9996, commitment: "annual_yearly",
    })]);
    expect(db.tables.leads[0]).toMatchObject({ contact_email: "buyer@example.invalid", state_code: "07", plan: "support-standard", stage: "quote" });
  });

  it("Standard monthly = one month (₹999 + GST = ₹1,179) on a monthly line and a billing_cycle 'monthly' quote", async () => {
    const res = await order({ ...BODY, term: "monthly" });
    expect(res.status).toBe(200);
    const q = db.tables.quotes[0];
    expect(q).toMatchObject({ amount: 1179, subtotal: 999, billing_cycle: "monthly" });
    expect((q.line_items as Row[])[0]).toMatchObject({ item_id: `SUP-STANDARD-MO-${T32}`, rate: 999, commitment: "monthly" });
  });

  it("Enterprise yearly finds the company's row by its id when the row has no sku (Add to catalog)", async () => {
    await order({ ...BODY, plan: "enterprise" });
    expect((db.tables.quotes[0].line_items as Row[])[0]).toMatchObject({ item_id: `SUP-ENTERPRISE-YR-${T32}`, rate: 49992 });
    expect(db.tables.quotes[0].amount).toBe(58991);
  });

  it("no catalogue row for the plan → refused before anything is saved (the subscription could not reach the desk)", async () => {
    const res = await order({ ...BODY, plan: "enterprise", term: "monthly" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/Nothing was charged/);
    expect(db.tables.leads).toHaveLength(0);
    expect(rzp.orders).toHaveLength(0);
  });

  it("Free and unknown plans are refused; no state and no GSTIN is refused — nothing saved or charged", async () => {
    for (const bad of [{ ...BODY, plan: "free" }, { ...BODY, plan: "premium" }, { ...BODY, term: "weekly" }]) {
      expect((await order(bad)).status).toBe(400);
    }
    const noState = await order({ ...BODY, stateCode: undefined });
    expect(noState.status).toBe(400);
    expect((await noState.json()).needState).toBe(true);
    expect(db.tables.leads).toHaveLength(0);
    expect(rzp.orders).toHaveLength(0);
  });

  it("billing_customer_id + the same email → the order is that customer's (number or uuid)", async () => {
    await order({ ...BODY, billingCustomerId: "C-0042" });
    expect(db.tables.quotes[0]).toMatchObject({ customer_id: CUST, customer_name: "AITEST Desk Customer" });
    expect(db.tables.leads[0].customer_id).toBe(CUST);
    seed();
    await order({ ...BODY, billingCustomerId: CUST });
    expect(db.tables.quotes[0].customer_id).toBe(CUST);
  });

  it("billing_customer_id with another email, or another company's customer → not attached (the lead path finds the customer)", async () => {
    await order({ ...BODY, email: "someone.else@example.invalid", billingCustomerId: "C-0042" });
    expect(db.tables.quotes[0].customer_id).toBeNull();
    seed();
    db.tables.customers[0].tenant_id = "other-tenant";
    await order({ ...BODY, billingCustomerId: "C-0042" });
    expect(db.tables.quotes[0].customer_id).toBeNull();
  });

  it("a customer already on a paid support plan is not sold a second one (409, nothing saved)", async () => {
    db.tables.subscriptions.push({ id: "s1", tenant_id: TENANT, customer_id: CUST, vendor: "support", status: "active", plan: "Support Standard (Yearly)", renewal_date: "2027-03-01" });
    const res = await order({ ...BODY, plan: "enterprise", billingCustomerId: "C-0042" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already have Support Standard \(Yearly\), paid until 2027-03-01/);
    expect(db.tables.leads).toHaveLength(0);
    expect(rzp.orders).toHaveLength(0);
  });
});

describe("R-2083 after payment — verify (and the webhook) settle it once", () => {
  async function paid() {
    await order(BODY);
    rzp.payment = {
      id: PAY, order_id: ORDER, amount: 1179500, currency: "INR", status: "captured", method: "upi",
      email: "buyer@example.invalid", notes: { quoteId: QUOTE, tierName: "Standard Support (Yearly)", seats: "1", domain: "", contact: "AITEST Buyer" },
    };
    db.rpcCalls = [];
  }

  it("a good signature: record_payment once with Razorpay's amount, GST invoice issued, paid", async () => {
    await paid();
    const r = await verify();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "paid", quoteId: QUOTE, invoiceId: "INV-AITEST-2083" });
    expect(db.rpcCalls.map((c) => c.name)).toEqual(["record_payment", "generate_invoice"]);
    expect(db.rpcCalls[0].args).toMatchObject({ p_quote_id: QUOTE, p_amount: 11795, p_reference: PAY });
  });

  it("a forged signature is refused before Razorpay is asked; nothing recorded", async () => {
    await paid();
    const r = await verify(sign(ORDER, PAY, "not-the-secret"));
    expect(r.status).toBe(400);
    expect(r.body.state).toBe("refused");
    expect(rzp.fetched).toEqual([]);
    expect(db.rpcCalls).toEqual([]);
  });

  it("verify twice, then the webhook: one payment, one invoice", async () => {
    await paid();
    await verify();
    const again = await verify();
    expect(again.body.state).toBe("paid");
    const raw = JSON.stringify({
      event: "payment.captured", created_at: 1,
      payload: { payment: { entity: { ...rzp.payment } }, order: { entity: { id: ORDER, receipt: QUOTE, amount: 1179500 } } },
    });
    const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    const res = await webhook(new NextRequest(`https://shop.example.invalid/api/webhooks/razorpay?tenant=${TENANT}`, {
      method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": sig }, body: raw,
    }));
    expect((await res.json()).alreadyProcessed).toBe(true);
    expect(db.rpcCalls.map((c) => c.name)).toEqual(["record_payment", "generate_invoice"]);
    expect(db.tables.payments).toHaveLength(1);
  });

  it("nothing is queued for provisioning, and the buyer's mail is about support (no DNS / seats)", async () => {
    await paid();
    await verify();
    expect(queueProvisioning).not.toHaveBeenCalled();
    const mail = sendEmail.mock.calls.map((c) => c[0] as { kind?: string; text?: string }).find((m) => m.kind === "razorpay_payment_customer");
    expect(mail?.text).toMatch(/Standard Support \(Yearly\) plan is switched on at our support desk/);
    expect(mail?.text).not.toMatch(/Seats|DNS|TXT/);
    const owner = sendEmail.mock.calls.map((c) => c[0] as { kind?: string; text?: string }).find((m) => m.kind === "razorpay_payment_owner");
    expect(owner?.text).toMatch(/NOTHING TO SET UP BY HAND/);
    expect(owner?.text).not.toMatch(/Google Reseller Console/);
  });
});
