/**
 * R-1985 (Pardeep, 26 Oct 2026): a MONTHLY Workspace order with a NEW domain is ONE Razorpay
 * payment over TWO quotes — the Workspace flex quote and the domain's own quote (checkout route:
 * route.monthly-domain-r1985.test.ts). The webhook records it as TWO payments rows with the SAME
 * Razorpay payment id — ₹3,068 on the Workspace quote, ₹766 on the domain quote — and each quote
 * invoices itself. A repeat delivery (or order.paid for the same payment) records nothing more;
 * a delivery after only the first share was recorded records only the second. A payment that is
 * not exactly the sum is never recorded — the owner is told.
 */
import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
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
vi.hoisted(() => { process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_global_r1985"; });
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as { name: string; args: Row }[],
  invoices: [] as string[],
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
      ilike: () => q,
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
      insert: async (row: Row) => { (db.tables[table] ??= []).push({ ...row }); return { data: null, error: null }; },
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
      /* As the SQL does (r1985_monthly_domain_split.test.sql): a payment id this QUOTE already
         holds is answered already_recorded; otherwise the payment is written, the quote is
         received in full, takes the payment id as its payment_reference, and the lead's customer. */
      rpc: async (name: string, args: Row) => {
        db.rpcCalls.push({ name, args });
        if (name !== "record_payment") return { data: null, error: null };
        const q = db.tables.quotes.find((r) => r.id === args.p_quote_id)!;
        if (db.tables.payments.some((r) => r.quote_id === q.id && r.reference === args.p_reference && r.status === "received")) {
          return { data: { already_recorded: true }, error: null };
        }
        db.tables.payments.push({
          id: `p-${String(q.id)}`, tenant_id: q.tenant_id, quote_id: q.id, reference: args.p_reference,
          method: args.p_method, status: "received", amount: args.p_amount,
        });
        Object.assign(q, { payment_status: "received", payment_reference: args.p_reference, customer_id: "cust-r1985" });
        return { data: { payment_id: `p-${String(q.id)}`, customer_id: "cust-r1985" }, error: null };
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
  loadOwnerAlert: async () => ({ alert: { ok: true, to: "owner@example.invalid" }, tenant: { name: "R1985 Seller" } }),
}));
vi.mock("@/lib/ai/autonomy.server", () => ({ loadAutonomyPolicy: async () => ({ modes: {} }) }));
const queueProvisioning = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => "queued"));
vi.mock("@/lib/provisioning/provisioning.server", () => ({ queueProvisioning }));
vi.mock("@/lib/razorpay/fee-expense.server", () => ({ bookGatewayFeeExpense: vi.fn(async () => "booked") }));
vi.mock("@/lib/pdf/pdf-token", () => ({
  pdfDownloadUrl: (base: string, kind: string, id: string) => `${base}/api/pdf/${kind}/${id}?sig=test`,
}));
/* Each quote invoices itself (instalment / generate_invoice) — counted here, proven in SQL. */
vi.mock("@/lib/checkout/online-invoice.server", () => ({
  issueInvoiceForOnlinePayment: vi.fn(async (_a: unknown, args: { quoteId: string }) => {
    db.invoices.push(args.quoteId);
    return { status: "issued", invoiceId: `INV-${args.quoteId}` };
  }),
}));

import { POST } from "./route";

const TENANT = "19851985-1985-4985-8985-198519851985";
const SECRET = "whsec_r1985";
const WS = "Q-R1985-0001";
const DOM = "Q-R1985-0002";
const LEAD = "L-R1985";
const ORDER = "order_R1985";
const PAY = "pay_R1985";

function seed() {
  db.tables = {
    tenant_secrets: [{ tenant_id: TENANT, razorpay_webhook_secret: SECRET, razorpay_key_id: "rzp_test_r1985" }],
    quotes: [
      {
        id: WS, tenant_id: TENANT, customer_name: "Ravi Traders", amount: 3068, subtotal: 2600, tax_rate: 18,
        payment_status: "awaiting", lead_id: LEAD, seats: 2, plan: "google-workspace-standard", billing_cycle: "monthly",
        line_items: [{ name: "Google Workspace Business Standard — monthly (flex)", qty: 2, rate: 1300, commitment: "monthly" }],
        is_renewal: false, invoice_id: null, payment_reference: ORDER, customer_id: null, status: "sent",
      },
      {
        id: DOM, tenant_id: TENANT, customer_name: "Ravi Traders", amount: 766, subtotal: 649, tax_rate: 18,
        payment_status: "awaiting", lead_id: LEAD, seats: 1, plan: "domain-registration",
        line_items: [{ name: "Domain ravitraders.in — registration, 1 year", qty: 1, rate: 649, domain: "ravitraders.in", years: 1, registrant: { firstName: "Ravi" } }],
        is_renewal: false, invoice_id: null, payment_reference: ORDER, customer_id: null, status: "sent",
      },
    ],
    payments: [], subscriptions: [], items: [], lead_activities: [], notifications: [],
  };
  db.rpcCalls = [];
  db.invoices = [];
}

function signed(event: Row) {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
  return new NextRequest(`https://shop.example.invalid/api/webhooks/razorpay?tenant=${TENANT}`, {
    method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": sig }, body: raw,
  });
}

/* payment.captured carries only the payment (notes from the browser checkout: quoteId = Q1). */
const captured = (o: { amount?: number; method?: string; event?: string; withOrder?: boolean } = {}) => ({
  event: o.event ?? "payment.captured",
  created_at: 1,
  payload: {
    payment: { entity: {
      id: PAY, order_id: ORDER, amount: o.amount ?? 383400, currency: "INR", status: "captured", method: o.method ?? "card",
      email: "ravi@example.invalid", notes: { quoteId: WS, domain: "ravitraders.in" }, fee: 9046, tax: 1380,
    } },
    ...(o.withOrder ? { order: { entity: {
      id: ORDER, receipt: WS, amount: 383400,
      notes: { quoteId: WS, splitQuoteIds: `${WS},${DOM}`, splitShares: "3068,766" },
    } } } : {}),
  },
});

const records = () => db.rpcCalls.filter((c) => c.name === "record_payment").map((c) => c.args);
const customerMails = () => sendEmail.mock.calls.map((c) => c[0] as { kind: string; text: string; subject: string })
  .filter((m) => m.kind === "razorpay_payment_customer");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://shop.example.invalid");
  seed();
  sendEmail.mockClear();
  queueProvisioning.mockClear();
});

describe("R-1985 webhook — one payment, two quotes, two payments rows", () => {
  it("payment.captured ₹3,834 → record_payment(Workspace, 3,068) then record_payment(domain, 766), same reference; both invoiced", async () => {
    const res = await POST(signed(captured()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(records()).toEqual([
      expect.objectContaining({ p_quote_id: WS, p_amount: 3068, p_reference: PAY }),
      expect.objectContaining({ p_quote_id: DOM, p_amount: 766, p_reference: PAY }),
    ]);
    expect(db.tables.payments.map((p) => [p.quote_id, p.amount, p.reference])).toEqual([[WS, 3068, PAY], [DOM, 766, PAY]]);
    expect(db.invoices).toEqual([WS, DOM]);
    expect(body).toMatchObject({ received: true, split: true, quoteId: WS, invoiceId: `INV-${WS}` });
    expect(body.parts.map((p: { quoteId: string }) => p.quoteId)).toEqual([WS, DOM]);
  });

  it("Razorpay's fee is kept on the Workspace share only (booked once)", async () => {
    await POST(signed(captured()));
    const ws = db.tables.payments.find((p) => p.quote_id === WS)!;
    const dom = db.tables.payments.find((p) => p.quote_id === DOM)!;
    expect(ws.gateway_fee).toBe(90);
    expect(dom.gateway_fee).toBeUndefined();
  });

  it("ONE confirmation mail to the buyer, for the whole ₹3,834; the domain is queued for registration", async () => {
    await POST(signed(captured()));
    expect(customerMails()).toHaveLength(1);
    expect(customerMails()[0].subject).toContain("₹3,834");
    const vendors = queueProvisioning.mock.calls.map((c) => (c[0] as { vendor: string; quoteId: string }));
    expect(vendors).toContainEqual(expect.objectContaining({ vendor: "domain", quoteId: DOM, domain: "ravitraders.in" }));
  });

  it("a repeat delivery — and order.paid with the split notes — records nothing more (idempotent)", async () => {
    await POST(signed(captured()));
    const mails = sendEmail.mock.calls.length;
    const again = await POST(signed(captured()));
    expect((await again.json()).alreadyProcessed).toBe(true);
    const orderPaid = await POST(signed(captured({ event: "order.paid", withOrder: true })));
    expect((await orderPaid.json()).alreadyProcessed).toBe(true);
    expect(db.tables.payments).toHaveLength(2);
    expect(db.invoices).toEqual([WS, DOM]);
    expect(sendEmail.mock.calls.length).toBe(mails);
  });

  it("only the Workspace share was recorded before (a retry after a failure) → only the domain share is recorded now", async () => {
    db.tables.payments.push({ id: "p-ws", tenant_id: TENANT, quote_id: WS, reference: PAY, method: "card", status: "received", amount: 3068 });
    Object.assign(db.tables.quotes[0], { payment_status: "received", payment_reference: PAY });
    const res = await POST(signed(captured()));
    expect(res.status).toBe(200);
    expect(records()).toEqual([expect.objectContaining({ p_quote_id: DOM, p_amount: 766, p_reference: PAY })]);
    expect(db.tables.payments).toHaveLength(2);
  });

  it("paid by UPI → the domain share is recorded as razorpay (R-1676 lets a bank UTR onto one payment only)", async () => {
    await POST(signed(captured({ method: "upi" })));
    expect(records().map((r) => r.p_method)).toEqual(["upi", "razorpay"]);
  });

  it("a payment that is not exactly 3,068 + 766 is never recorded — the owner is told", async () => {
    const res = await POST(signed(captured({ amount: 306800 })));
    expect(res.status).toBe(200);
    expect((await res.json()).needsReview).toBe(true);
    expect(records()).toHaveLength(0);
    expect(db.tables.payments).toHaveLength(0);
  });
});
