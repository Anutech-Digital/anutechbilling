/**
 * R-1596 — the website order is completed when the buyer comes back from Razorpay, not
 * only when (and if) Razorpay's webhook arrives.
 *
 * Before this card the checkout's Razorpay success handler only cleared the cart and opened
 * /done; nothing on our server looked at the payment, so with no webhook (local, staging, or
 * a late/failed delivery on live) the quote stayed "awaiting" forever while /done said
 * "Payment received".
 *
 * Pinned with a mocked database and a mocked Razorpay API:
 *  - verify alone (no webhook) records the payment, issues the GST invoice, answers "paid";
 *  - the webhook arriving after verify is a no-op, and verify after the webhook too;
 *  - verify twice (a reload of /done) records once;
 *  - a bad signature is refused before Razorpay is even asked;
 *  - an amount that differs from the quote is refused, whatever the browser sent;
 *  - a payment that is only authorised answers "confirming" and records nothing.
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
      ilike: (c: string, pat: string) => {
        const needle = pat.replace(/%/g, "").toLowerCase();
        filters.push((r) => String(r[c] ?? "").toLowerCase().includes(needle));
        return q;
      },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return q; },
      limit: (n: number) => { lim = n; return q; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => {
        const r = rows()[0];
        return r ? { data: r, error: null } : { data: null, error: { message: "not found" } };
      },
      update: (patch: Row) => { pendingUpdate = patch; return q; },
      insert: async (row: Row) => {
        (db.tables[table] ??= []).push({ ...row });
        return { data: null, error: null };
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

/* Razorpay's own API, as the server would see it: GET /payments/:id. */
const rzp = vi.hoisted(() => ({
  payment: null as null | Row,
  fetched: [] as string[],
  keys: [] as string[],
}));
vi.mock("razorpay", () => ({
  default: class {
    payments: { fetch: (id: string) => Promise<Row> };
    constructor(opts: { key_id: string }) {
      rzp.keys.push(opts.key_id);
      this.payments = {
        fetch: async (id: string) => {
          rzp.fetched.push(id);
          if (!rzp.payment || rzp.payment.id !== id) throw { statusCode: 400, error: { description: "The id provided does not exist" } };
          return rzp.payment;
        },
      };
    }
  },
}));

import { verifyCheckoutPayment } from "./verify-payment.server";
import { POST as webhook } from "@/app/api/webhooks/razorpay/route";
import { DEV_BUY_PAGE_TENANT_ID } from "./live-guards";

const TENANT = DEV_BUY_PAGE_TENANT_ID;
const KEY_SECRET = "rzp_secret_aitest";
const WEBHOOK_SECRET = "whsec_aitest";
const QUOTE = "Q-AITEST-1596";
const ORDER = "order_AITEST1596";
const PAY = "pay_AITEST1596";

function seed() {
  db.tables = {
    tenant_secrets: [{
      tenant_id: TENANT, razorpay_key_id: "rzp_test_aitest", razorpay_key_secret: KEY_SECRET,
      razorpay_mode: "test", razorpay_webhook_secret: WEBHOOK_SECRET,
    }],
    quotes: [{
      id: QUOTE, tenant_id: TENANT, customer_name: "AITEST Buyer Co", amount: 1180, payment_status: "awaiting",
      lead_id: "L-AITEST", seats: 1, plan: "hosting-starter", line_items: [], is_renewal: false, status: "sent",
      superseded_by: null, invoice_id: null, public_token: "tok", payment_reference: ORDER, customer_id: null,
    }],
    payments: [], subscriptions: [], items: [], lead_activities: [],
  };
  db.rpcCalls = [];
  db.rpcImpl = (name, args) => {
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
      q.invoice_id = "INV-AITEST-1596";
      q.payment_status = "invoiced";
      return { data: [{ invoice_id: "INV-AITEST-1596" }], error: null };
    }
    return { data: null, error: null };
  };
  rzp.payment = {
    id: PAY, order_id: ORDER, amount: 118000, currency: "INR", status: "captured", method: "upi",
    email: "buyer@example.invalid", notes: { quoteId: QUOTE },
  };
  rzp.fetched = [];
  rzp.keys = [];
}

const sign = (orderId: string, paymentId: string, secret = KEY_SECRET) =>
  crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

const req = () => new NextRequest("https://shop.example.invalid/api/public/checkout/verify", { method: "POST" });
const verify = (over: Partial<{ orderId: string; paymentId: string; signature: string; amount: number }> = {}) =>
  verifyCheckoutPayment(req(), {
    orderId: ORDER, paymentId: PAY, signature: sign(over.orderId ?? ORDER, over.paymentId ?? PAY), ...over,
  });

function signedWebhook(event: Row) {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return new NextRequest(`https://shop.example.invalid/api/webhooks/razorpay?tenant=${TENANT}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-razorpay-signature": sig },
    body: raw,
  });
}
const captured = () => ({
  event: "payment.captured",
  created_at: 1,
  payload: {
    payment: { entity: { ...rzp.payment } },
    order: { entity: { id: ORDER, receipt: QUOTE, amount: 118000 } },
  },
});

const rpcNames = () => db.rpcCalls.map((c) => c.name);
const ENV = { ...process.env };

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://shop.example.invalid");
  seed();
  sendEmail.mockClear();
  queueProvisioning.mockClear();
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("R-1596 — the order is completed when the buyer returns, without the webhook", () => {
  it("verify alone records the payment, issues the GST invoice and answers paid", async () => {
    const r = await verify();
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("paid");
    expect(r.body.quoteId).toBe(QUOTE);
    expect(r.body.invoiceId).toBe("INV-AITEST-1596");
    expect(rpcNames()).toEqual(["record_payment", "generate_invoice"]);
    // The amount comes from Razorpay's own record of the payment, in rupees.
    expect(db.rpcCalls[0].args).toMatchObject({ p_quote_id: QUOTE, p_amount: 1180, p_reference: PAY, p_method: "upi" });
    expect(db.tables.quotes[0].payment_status).toBe("invoiced");
    // Asked Razorpay itself, with this tenant's key — the browser's word is not enough.
    expect(rzp.fetched).toEqual([PAY]);
    expect(rzp.keys).toEqual(["rzp_test_aitest"]);
    // The same downstream as the webhook: activation queued, confirmation mailed.
    expect(queueProvisioning).toHaveBeenCalled();
    expect(sendEmail.mock.calls.some((c) => (c[0] as { kind?: string }).kind === "razorpay_payment_customer")).toBe(true);
  });

  it("the webhook arriving after verify is a no-op", async () => {
    await verify();
    const mails = sendEmail.mock.calls.length;
    const queued = queueProvisioning.mock.calls.length;
    const res = await webhook(signedWebhook(captured()));
    expect(res.status).toBe(200);
    expect((await res.json()).alreadyProcessed).toBe(true);
    expect(rpcNames()).toEqual(["record_payment", "generate_invoice"]);
    expect(db.tables.payments).toHaveLength(1);
    expect(sendEmail.mock.calls.length).toBe(mails);
    expect(queueProvisioning.mock.calls.length).toBe(queued);
  });

  it("verify after the webhook answers paid and records nothing more", async () => {
    await webhook(signedWebhook(captured()));
    const before = rpcNames().length;
    const r = await verify();
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("paid");
    expect(r.body.invoiceId).toBe("INV-AITEST-1596");
    expect(rpcNames().length).toBe(before);
    expect(db.tables.payments).toHaveLength(1);
  });

  it("verify twice (a reload of /done) records once", async () => {
    await verify();
    const again = await verify();
    expect(again.body.state).toBe("paid");
    expect(rpcNames()).toEqual(["record_payment", "generate_invoice"]);
    expect(db.tables.payments).toHaveLength(1);
  });
});

describe("R-1596 — what verify refuses", () => {
  it("a bad signature is refused before Razorpay is asked, and nothing is recorded", async () => {
    const r = await verify({ signature: sign(ORDER, PAY, "not-the-secret") });
    expect(r.status).toBe(400);
    expect(r.body.state).toBe("refused");
    expect(rzp.fetched).toEqual([]);
    expect(db.rpcCalls).toEqual([]);
  });

  it("a signature for another payment id does not carry over", async () => {
    const r = await verifyCheckoutPayment(req(), { orderId: ORDER, paymentId: "pay_OTHER", signature: sign(ORDER, PAY) });
    expect(r.status).toBe(400);
    expect(db.rpcCalls).toEqual([]);
  });

  it("an amount that differs from the quote is refused, whatever the browser sends", async () => {
    rzp.payment = { ...rzp.payment, amount: 100 }; // ₹1 paid on a ₹1,180 order
    const r = await verify({ amount: 118000 });
    expect(r.status).toBe(409);
    expect(r.body.state).toBe("refused");
    expect(db.rpcCalls).toEqual([]);
    expect(db.tables.quotes[0].payment_status).toBe("awaiting");
  });

  it("a payment Razorpay files under a different order is refused", async () => {
    rzp.payment = { ...rzp.payment, order_id: "order_SOMEONE_ELSE" };
    const r = await verify();
    expect(r.status).toBe(409);
    expect(db.rpcCalls).toEqual([]);
  });

  it("an order id that is not one of our quotes is refused", async () => {
    const r = await verify({ orderId: "order_UNKNOWN", signature: sign("order_UNKNOWN", PAY) });
    expect(r.status).toBe(404);
    expect(db.rpcCalls).toEqual([]);
  });

  it("a payment that is only authorised answers confirming and records nothing", async () => {
    rzp.payment = { ...rzp.payment, status: "authorized" };
    const r = await verify();
    expect(r.status).toBe(202);
    expect(r.body.state).toBe("confirming");
    expect(db.rpcCalls).toEqual([]);
  });

  it("a failed payment answers failed and records nothing", async () => {
    rzp.payment = { ...rzp.payment, status: "failed" };
    const r = await verify();
    expect(r.body.state).toBe("failed");
    expect(db.rpcCalls).toEqual([]);
  });

  it("a malformed body is refused", async () => {
    const r = await verifyCheckoutPayment(req(), { orderId: ORDER });
    expect(r.status).toBe(400);
    expect(db.rpcCalls).toEqual([]);
  });
});

describe("R-1985 — a monthly order with a new domain: one payment over the Workspace + domain quotes", () => {
  const DOM = "Q-AITEST-1597";
  function seedSplit() {
    Object.assign(db.tables.quotes[0], { amount: 3068, plan: "google-workspace-standard" });
    db.tables.quotes.push({
      id: DOM, tenant_id: TENANT, customer_name: "AITEST Buyer Co", amount: 766, payment_status: "awaiting",
      lead_id: "L-AITEST", seats: 1, plan: "domain-registration", line_items: [], is_renewal: false, status: "sent",
      superseded_by: null, invoice_id: null, public_token: "tok2", payment_reference: ORDER, customer_id: null,
    });
    rzp.payment = { ...rzp.payment!, amount: 383400, method: "card" };
  }

  it("verify expects the SUM (₹3,834) and records each share on its own quote, same reference", async () => {
    seedSplit();
    const r = await verify();
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("paid");
    expect(r.body.quoteId).toBe(QUOTE);
    const recs = db.rpcCalls.filter((c) => c.name === "record_payment").map((c) => c.args);
    expect(recs).toEqual([
      expect.objectContaining({ p_quote_id: QUOTE, p_amount: 3068, p_reference: PAY }),
      expect.objectContaining({ p_quote_id: DOM, p_amount: 766, p_reference: PAY }),
    ]);
  });

  it("the webhook after verify records nothing more", async () => {
    seedSplit();
    await verify();
    const n = db.tables.payments.length;
    const res = await webhook(signedWebhook(captured()));
    expect((await res.json()).alreadyProcessed).toBe(true);
    expect(db.tables.payments.length).toBe(n);
  });

  it("only the Workspace share paid by Razorpay (₹3,068) is refused, nothing recorded", async () => {
    seedSplit();
    rzp.payment = { ...rzp.payment!, amount: 306800 };
    const r = await verify();
    expect(r.status).toBe(409);
    expect(db.rpcCalls.filter((c) => c.name === "record_payment")).toHaveLength(0);
  });
});
