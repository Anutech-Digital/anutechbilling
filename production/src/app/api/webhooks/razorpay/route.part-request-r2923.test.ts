/**
 * R-2923 (18 Nov 2026, found by the R-2922 review): a part (month / quarter / half-year) payment request paid
 * at Razorpay is the payment for a period of a subscription that is ALREADY running. The webhook treated it as
 * a new sale: it read the vendor off the plan's wording ("Google Workspace …" → google, "… hosting" →
 * hosting) and queued provisioning, could file a domain subscription, and mailed the buyer "Thanks for your
 * purchase … WHAT HAPPENS NEXT" with set-up steps and the desk "ACTION REQUIRED — provision N licenses".
 *
 * Now it follows Record payment on that request: record_payment, then the part's own tax invoice
 * (issueInvoiceForOnlinePayment → the part's instalment invoice) — and nothing of a new sale. The buyer gets a
 * plain receipt with the invoice link; the owner an alert with no set-up steps.
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
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as { name: string; args: Row }[],
  invoices: [] as string[],
  inserts: [] as { table: string; row: Row }[],
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
      insert: async (row: Row) => { db.inserts.push({ table, row }); (db.tables[table] ??= []).push({ ...row }); return { data: null, error: null }; },
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
      /* As record_payment does: a payment id the quote already holds → already_recorded; else the payment is
         written and the quote is received in full. */
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
        Object.assign(q, { payment_status: "received", payment_reference: args.p_reference });
        return { data: { payment_id: `p-${String(q.id)}`, customer_id: q.customer_id }, error: null };
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
  loadOwnerAlert: async () => ({ alert: { ok: true, to: "owner@example.invalid" }, tenant: { name: "R2923 Seller", phone: "9800000000" } }),
}));
vi.mock("@/lib/ai/autonomy.server", () => ({ loadAutonomyPolicy: async () => ({ modes: {} }) }));
const queueProvisioning = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => "queued"));
vi.mock("@/lib/provisioning/provisioning.server", () => ({ queueProvisioning }));
const ensurePanelAccount = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ kind: "skipped", reason: "test" })));
vi.mock("@/lib/provisioning/panel-account.server", () => ({ ensurePanelAccount }));
vi.mock("@/lib/razorpay/fee-expense.server", () => ({ bookGatewayFeeExpense: vi.fn(async () => "booked") }));
vi.mock("@/lib/pdf/pdf-token", () => ({
  pdfDownloadUrl: (base: string, kind: string, id: string) => `${base}/api/pdf/${kind}/${id}?sig=test`,
}));
/* The part's own tax invoice (the path Record payment's money takes; proven in SQL — r2923_part_invoice_cost). */
vi.mock("@/lib/checkout/online-invoice.server", () => ({
  issueInvoiceForOnlinePayment: vi.fn(async (_a: unknown, args: { quoteId: string }) => {
    db.invoices.push(args.quoteId);
    return { status: "issued", invoiceId: `INV-${args.quoteId}` };
  }),
}));

import { POST } from "./route";

const TENANT = "29232923-2923-4923-8923-292329232923";
const SECRET = "whsec_r2923";
const PART = "PI-R2923-0007";      // one subscription's month
const TOGETHER = "PI-R2923-0008";  // two subscriptions billed together
const SALE = "Q-R2923-0001";       // a real new sale — unchanged
const BILLING = "b2923000-0000-4000-8000-000000000301";

/** As the database writes a part line since R-2922 (supabase/tests/r2922_part_request_like_renewal.test.sql). */
const partLine = (id: string, name: string, itemId: string, extra: Row = {}) => ({
  id, name, description: "Payment for month 2 · 15 Oct–14 Nov 2026", qty: 49, rate: 450, per_seat: true, cost: 300, one_time: true,
  item_id: itemId, period_start: "2026-10-15", period_end: "2026-11-14", ...extra,
});

function seed() {
  db.tables = {
    tenant_secrets: [{ tenant_id: TENANT, razorpay_webhook_secret: SECRET, razorpay_key_id: "rzp_test_r2923" }],
    quotes: [
      {
        id: PART, tenant_id: TENANT, customer_name: "Ravi Traders", customer_id: "cust-r2923", amount: 26019, subtotal: 22050, tax_rate: 18,
        payment_status: "awaiting", lead_id: null, seats: 49, plan: "Google Workspace Business Starter", billing_cycle: null,
        subscription_billing_id: BILLING, is_one_off: true, is_renewal: false, invoice_id: null, payment_reference: null, status: "sent",
        line_items: [partLine("part-2", "Google Workspace Business Starter · ravitraders.in · 49 seats · 15 Oct–14 Nov 2026 (part 2 of 12)", "GW-STR")],
      },
      {
        /* plan wording that reads as hosting + domain, lines that name a hosting and a domain catalogue item and a domain */
        id: TOGETHER, tenant_id: TENANT, customer_name: "Ravi Traders", customer_id: "cust-r2923", amount: 1180, subtotal: 1000, tax_rate: 18,
        payment_status: "awaiting", lead_id: null, seats: 2, plan: "Starter hosting + .in domain", billing_cycle: null,
        subscription_billing_id: BILLING, is_one_off: true, is_renewal: false, invoice_id: null, payment_reference: null, status: "sent",
        line_items: [
          partLine("part-2-1", "Starter hosting · ravitraders.in · 1 seat · 15 Oct–14 Nov 2026 (part 2 of 12)", "HOST-STARTER", { qty: 1, rate: 500, domain: "ravitraders.in", billing_id: BILLING }),
          partLine("part-2-2", "Domain ravitraders.in · 1 seat · 15 Oct–14 Nov 2026 (part 2 of 12)", "DOM-IN", { qty: 1, rate: 500, domain: "ravitraders.in", years: 1, billing_id: "b2923000-0000-4000-8000-000000000302" }),
        ],
      },
      {
        id: SALE, tenant_id: TENANT, customer_name: "Naya Traders", customer_id: null, amount: 26019, subtotal: 22050, tax_rate: 18,
        payment_status: "awaiting", lead_id: null, seats: 49, plan: "Google Workspace Business Starter", billing_cycle: null,
        subscription_billing_id: null, is_one_off: false, is_renewal: false, invoice_id: null, payment_reference: null, status: "sent",
        line_items: [{ id: "li-1", name: "Google Workspace Business Starter", qty: 49, rate: 450, item_id: "GW-STR" }],
      },
    ],
    items: [
      { id: "GW-STR", tenant_id: TENANT, vendor: "google" },
      { id: "HOST-STARTER", tenant_id: TENANT, vendor: "hosting" },
      { id: "DOM-IN", tenant_id: TENANT, vendor: "domain" },
    ],
    payments: [], subscriptions: [], lead_activities: [], notifications: [],
  };
  db.rpcCalls = [];
  db.invoices = [];
  db.inserts = [];
}

function signed(event: Row) {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
  return new NextRequest(`https://shop.example.invalid/api/webhooks/razorpay?tenant=${TENANT}`, {
    method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": sig }, body: raw,
  });
}

const captured = (quoteId: string, rupees: number, payId = `pay_${quoteId}`) => ({
  event: "payment.captured",
  created_at: 1,
  payload: {
    payment: { entity: {
      id: payId, order_id: `order_${quoteId}`, amount: rupees * 100, currency: "INR", status: "captured", method: "card",
      email: "ravi@example.invalid", notes: { quoteId, domain: "ravitraders.in", seats: "49", tierName: "Business Starter" }, fee: 9046, tax: 1380,
    } },
  },
});

const records = () => db.rpcCalls.filter((c) => c.name === "record_payment").map((c) => c.args);
const mails = (kind: string) => sendEmail.mock.calls.map((c) => c[0] as { kind: string; text: string; subject: string }).filter((m) => m.kind === kind);

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://shop.example.invalid");
  vi.stubEnv("NO_OWNER_PAYMENT_ALERT_LOCAL", "");
  seed();
  sendEmail.mockClear();
  queueProvisioning.mockClear();
  ensurePanelAccount.mockClear();
});

describe("R-2923 webhook — a part payment request paid at Razorpay is a period's payment, never a new sale", () => {
  it("records the payment on the request and raises the part's tax invoice — as Record payment does", async () => {
    const res = await POST(signed(captured(PART, 26019)));
    expect(res.status).toBe(200);
    expect(records()).toEqual([expect.objectContaining({ p_quote_id: PART, p_amount: 26019, p_reference: `pay_${PART}`, p_method: "razorpay" })]);
    expect(db.invoices).toEqual([PART]);
    expect(await res.json()).toMatchObject({ received: true, quoteId: PART, paid: 26019, invoiceId: `INV-${PART}`, invoice: "issued", partRequest: true });
  });

  it("queues NO provisioning though the plan's wording says Google Workspace; files no subscription; sends no panel login", async () => {
    await POST(signed(captured(PART, 26019)));
    expect(queueProvisioning).not.toHaveBeenCalled();
    expect(db.inserts.filter((i) => i.table === "subscriptions")).toEqual([]);
    expect(ensurePanelAccount).not.toHaveBeenCalled();
  });

  it("billed together, wording and lines that read as hosting + a domain: no hosting account, no registration, no domain subscription", async () => {
    const res = await POST(signed(captured(TOGETHER, 1180)));
    expect(res.status).toBe(200);
    expect((await res.json()).partRequest).toBe(true);
    expect(queueProvisioning).not.toHaveBeenCalled();
    expect(db.inserts.filter((i) => i.table === "subscriptions")).toEqual([]);
    expect(db.invoices).toEqual([TOGETHER]);
  });

  it("the buyer gets a plain receipt with the invoice link — no 'purchase', no set-up steps", async () => {
    await POST(signed(captured(PART, 26019)));
    const customer = mails("razorpay_payment_customer");
    expect(customer).toHaveLength(1);
    expect(customer[0].subject).toBe(`Payment received · ${PART} · ₹26,019`);
    expect(customer[0].text).toContain("Payment for month 2 · 15 Oct–14 Nov 2026");
    expect(customer[0].text).toContain("Google Workspace Business Starter · ravitraders.in · 49 seats");
    expect(customer[0].text).toContain(`https://shop.example.invalid/api/pdf/invoice/INV-${PART}?sig=test`);
    expect(customer[0].text).not.toMatch(/Thanks for your purchase|WHAT HAPPENS NEXT|ORDER SUMMARY|DNS|TXT record/i);
  });

  it("the owner is told money came in for that period — with no 'provision it' steps; nobody gets a 'new paid order'", async () => {
    await POST(signed(captured(PART, 26019)));
    const owner = mails("razorpay_payment_owner");
    expect(owner).toHaveLength(1);
    expect(owner[0].text).toContain("Ravi Traders");
    expect(owner[0].text).toContain("Payment for month 2 · 15 Oct–14 Nov 2026");
    expect(owner[0].text).toContain(`INV-${PART}`);
    expect(owner[0].text).toContain("Nothing to set up: the subscription is already running.");
    expect(owner[0].text).not.toMatch(/ACTION REQUIRED|Provision|Reseller Console|direct-buy|CHECK THE SEATS/i);
    expect(mails("razorpay_payment_lead_owner")).toHaveLength(0);
  });

  it("the request's seats were changed before it was paid (set_part_request_terms) → the owner is told to check the licences", async () => {
    Object.assign(db.tables.quotes[0], { proforma_terms_set_at: "2026-10-16T05:00:00Z" });
    await POST(signed(captured(PART, 26019)));
    const owner = mails("razorpay_payment_owner");
    expect(owner[0].text).toContain("CHECK THE SEATS");
    expect(owner[0].text).not.toContain("Nothing to set up");
    expect(queueProvisioning).not.toHaveBeenCalled();
  });

  it("a cancelled request that let go of its part (cancelled_part_billing_id) and whose lines were lost is still a part request", async () => {
    Object.assign(db.tables.quotes[0], { subscription_billing_id: null, cancelled_part_billing_id: BILLING, line_items: [] });
    const res = await POST(signed(captured(PART, 26019)));
    expect((await res.json()).partRequest).toBe(true);
    expect(queueProvisioning).not.toHaveBeenCalled();
  });

  it("the invoice could not be issued (e.g. no state on the customer): the receipt says it will follow, nothing else changes", async () => {
    const { issueInvoiceForOnlinePayment } = await import("@/lib/checkout/online-invoice.server");
    vi.mocked(issueInvoiceForOnlinePayment).mockResolvedValueOnce({ status: "failed", reason: "no state" });
    const res = await POST(signed(captured(PART, 26019)));
    expect(await res.json()).toMatchObject({ received: true, partRequest: true, invoiceId: null, invoice: "failed" });
    expect(mails("razorpay_payment_customer")[0].text).toContain("Your GST tax invoice will reach you by email shortly.");
    expect(mails("razorpay_payment_owner")[0].text).toContain("NOT issued yet — no state");
    expect(queueProvisioning).not.toHaveBeenCalled();
  });

  it("a repeat delivery records nothing more and mails nobody again", async () => {
    await POST(signed(captured(PART, 26019)));
    const sent = sendEmail.mock.calls.length;
    const again = await POST(signed(captured(PART, 26019)));
    expect((await again.json()).alreadyProcessed).toBe(true);
    expect(db.tables.payments).toHaveLength(1);
    expect(db.invoices).toEqual([PART]);
    expect(sendEmail.mock.calls.length).toBe(sent);
    expect(queueProvisioning).not.toHaveBeenCalled();
  });

  it("a real new sale of the same plan is unchanged: its activation is queued and the buyer gets the order mail", async () => {
    const res = await POST(signed(captured(SALE, 26019)));
    expect(res.status).toBe(200);
    expect((await res.json()).partRequest).toBeUndefined();
    expect(queueProvisioning.mock.calls.map((c) => c[0])).toContainEqual(expect.objectContaining({ vendor: "google", quoteId: SALE, seats: 49 }));
    expect(ensurePanelAccount).toHaveBeenCalledTimes(1);
    expect(mails("razorpay_payment_customer")[0].text).toContain("Thanks for your purchase!");
  });
});
