/**
 * POST /api/webhooks/razorpay — R-079 (Pardeep, 1 Oct 2026).
 *
 * Pinned with signed, mocked Razorpay events:
 *  - payment.captured issues the GST invoice through generate_invoice (the desk's own
 *    path), after record_payment, and the response names the invoice;
 *  - the same event delivered again (and order.paid for the same payment) issues nothing
 *    more — no second record_payment, no second invoice, no second provisioning row;
 *  - a refused invoice (no place of supply) leaves a note on the lead and still answers 200;
 *  - payment.failed writes "Payment failed — <reason>" on the lead with a retry link to the
 *    SAME quote, never creates an order or charges, logs (not sends) the email off
 *    production, sends it in production, and a repeated delivery writes one note.
 */
import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
/* S24: the global (env) secret, read by the route at import — set before it loads. */
const GLOBAL_SECRET = vi.hoisted(() => { process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_global_aitest"; return "whsec_global_aitest"; });
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
      /* R-045: the refund-id claim is an optimistic update — "is null" or "array equals {a,b}". */
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return q; },
      filter: (c: string, op: string, lit: string) => {
        if (op !== "eq") throw new Error("mock: only the eq filter is modelled");
        filters.push((r) => Array.isArray(r[c]) && `{${(r[c] as unknown[]).join(",")}}` === lit);
        return q;
      },
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
        /* An update answers with the rows it MATCHED before the write (as RETURNING does). */
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
const bookGatewayFeeExpense = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => "booked"));
vi.mock("@/lib/razorpay/fee-expense.server", () => ({ bookGatewayFeeExpense }));
vi.mock("@/lib/pdf/pdf-token", () => ({
  pdfDownloadUrl: (base: string, kind: string, id: string) => `${base}/api/pdf/${kind}/${id}?sig=test`,
}));

import { POST } from "./route";
import { notifyTenantOwners } from "@/lib/notifications/notify.server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SECRET = "whsec_aitest";
const QUOTE = "Q-AITEST-0001";
const LEAD = "L-AITEST";

function seed() {
  db.tables = {
    tenant_secrets: [{ tenant_id: TENANT, razorpay_webhook_secret: SECRET, razorpay_key_id: "rzp_test_aitest" }],
    quotes: [{
      id: QUOTE, tenant_id: TENANT, customer_name: "AITEST Buyer Co", amount: 1180, payment_status: "awaiting",
      lead_id: LEAD, seats: 1, plan: "domain-registration", line_items: [], is_renewal: false,
      invoice_id: null, public_token: "tok_aitest", payment_reference: "order_AITEST1", customer_id: null,
    }],
    payments: [],
    subscriptions: [],
    items: [],
    lead_activities: [],
  };
  db.rpcCalls = [];
  /* A faithful-enough stand-in for the two RPCs: record_payment writes the payment and
     marks the quote received; generate_invoice refuses a second invoice exactly as the SQL
     does (unique_violation) and otherwise links one. */
  db.rpcImpl = (name, args) => {
    const q = db.tables.quotes.find((r) => r.id === args.p_quote_id)!;
    if (name === "record_payment") {
      /* As the SQL does under its row lock: a payment id it already holds is answered,
         not written again. */
      if (db.tables.payments.some((r) => r.quote_id === q.id && r.reference === args.p_reference && r.status === "received")) {
        return { data: { payment_id: "p1", already_recorded: true, idempotent_replay: true }, error: null };
      }
      db.tables.payments.push({ id: `p-${String(args.p_reference)}`, tenant_id: q.tenant_id, quote_id: q.id, reference: args.p_reference, status: "received", amount: args.p_amount });
      q.payment_status = "received";
      return { data: { payment_id: "p1" }, error: null };
    }
    if (name === "generate_invoice") {
      if (q.invoice_id) return { data: null, error: { code: "23505", message: `Invoice ${q.invoice_id} already exists` } };
      q.invoice_id = "INV-AITEST-0001";
      q.payment_status = "invoiced";
      return { data: [{ invoice_id: "INV-AITEST-0001", net_payable: 0, total_advances: 1180 }], error: null };
    }
    return { data: null, error: null };
  };
}

function signed(event: Row, opts: { secret?: string; tenant?: string | null } = {}) {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac("sha256", opts.secret ?? SECRET).update(raw).digest("hex");
  const tenant = opts.tenant === undefined ? TENANT : opts.tenant;
  return new NextRequest(`https://shop.example.invalid/api/webhooks/razorpay${tenant ? `?tenant=${tenant}` : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-razorpay-signature": sig },
    body: raw,
  });
}

const captured = (event = "payment.captured") => ({
  event,
  created_at: 1,
  payload: {
    payment: { entity: { id: "pay_AITEST1", order_id: "order_AITEST1", amount: 118000, currency: "INR", status: "captured", method: "card", email: "buyer@example.invalid", notes: { quoteId: QUOTE } } },
    order: { entity: { id: "order_AITEST1", receipt: QUOTE, amount: 118000 } },
  },
});

const failed = (payId = "pay_AITESTF1") => ({
  event: "payment.failed",
  created_at: 1,
  payload: {
    payment: { entity: {
      id: payId, order_id: "order_AITEST1", amount: 118000, currency: "INR", status: "failed", method: "card",
      email: "buyer@example.invalid", notes: { quoteId: QUOTE },
      error_code: "BAD_REQUEST_ERROR", error_description: "Your payment was declined by the bank", error_reason: "payment_failed",
    } },
  },
});

const rpcNames = () => db.rpcCalls.map((c) => c.name);
const ENV = { ...process.env };

beforeEach(() => {
  seed();
  sendEmail.mockClear();
  queueProvisioning.mockClear();
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("payment.captured — the GST invoice is issued automatically", () => {
  it("records the payment, then issues the invoice through generate_invoice", async () => {
    const res = await POST(signed(captured()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(rpcNames()).toEqual(["record_payment", "generate_invoice"]);
    expect(db.rpcCalls[1].args).toEqual({ p_quote_id: QUOTE });
    expect(body.invoiceId).toBe("INV-AITEST-0001");
    expect(body.invoice).toBe("issued");
    // The confirmation email links the invoice instead of promising one "shortly".
    const customerMail = sendEmail.mock.calls.map((c) => c[0] as { kind: string; text: string })
      .find((m) => m.kind === "razorpay_payment_customer");
    expect(customerMail?.text).toContain("/api/pdf/invoice/INV-AITEST-0001");
  });

  it("a repeated delivery — and order.paid for the same payment — issues nothing more", async () => {
    await POST(signed(captured()));
    const provisioned = queueProvisioning.mock.calls.length;
    const mails = sendEmail.mock.calls.length;

    const again = await POST(signed(captured()));
    expect(again.status).toBe(200);
    expect((await again.json()).alreadyProcessed).toBe(true);
    const orderPaid = await POST(signed(captured("order.paid")));
    expect((await orderPaid.json()).alreadyProcessed).toBe(true);

    expect(rpcNames()).toEqual(["record_payment", "generate_invoice"]); // once each, ever
    expect(db.tables.payments).toHaveLength(1);
    expect(queueProvisioning.mock.calls.length).toBe(provisioned);
    expect(sendEmail.mock.calls.length).toBe(mails);
  });

  it("an invoice already on the quote is reused, never a second one", async () => {
    db.tables.quotes[0].invoice_id = "INV-EXISTING";
    const res = await POST(signed(captured()));
    const body = await res.json();
    expect(rpcNames()).toEqual(["record_payment"]); // generate_invoice not even called
    expect(body.invoiceId).toBe("INV-EXISTING");
  });

  it("a refused invoice (no place of supply) still answers 200 and leaves a note on the lead", async () => {
    const base = db.rpcImpl!;
    db.rpcImpl = (name, args) =>
      name === "generate_invoice"
        ? { data: null, error: { code: "23514", message: "Cannot issue this invoice: AITEST Buyer Co has no state on record." } }
        : base(name, args);
    const res = await POST(signed(captured()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invoice).toBe("failed");
    expect(body.invoiceId).toBeNull();
    const note = db.tables.lead_activities.find((a) => a.lead_id === LEAD);
    expect(String(note?.detail)).toMatch(/GST invoice could not be issued automatically — Cannot issue this invoice/);
    expect(String(note?.detail)).toContain(QUOTE);
  });
});

describe("payment.failed — a note on the lead and a retry link, never a charge", () => {
  it("notes the reason on the lead with a retry link to the SAME quote; logs, does not send, off production", async () => {
    const res = await POST(signed(failed()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.retryUrl).toBe(`https://shop.example.invalid/quote/${QUOTE}/accept?t=tok_aitest`);

    const notes = db.tables.lead_activities.filter((a) => a.lead_id === LEAD);
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("note");
    expect(String(notes[0].detail)).toMatch(/^Payment failed — Your payment was declined by the bank\./);
    expect(String(notes[0].detail)).toContain("pay_AITESTF1");
    expect(String(notes[0].detail)).toContain(body.retryUrl);

    expect(db.rpcCalls).toEqual([]); // no record_payment, nothing settled or charged
    expect(db.tables.quotes[0].payment_status).toBe("awaiting");
    expect(sendEmail).not.toHaveBeenCalled(); // NODE_ENV=test → logged only
  });

  it("the same failure delivered twice writes one note", async () => {
    await POST(signed(failed()));
    const again = await POST(signed(failed()));
    expect((await again.json()).alreadyProcessed).toBe(true);
    expect(db.tables.lead_activities).toHaveLength(1);
    // A second, different failed attempt is its own note.
    await POST(signed(failed("pay_AITESTF2")));
    expect(db.tables.lead_activities).toHaveLength(2);
  });

  it("in production the retry link is emailed to the buyer through the app's email path", async () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    await POST(signed(failed()));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0] as { to: string; kind: string; text: string };
    expect(mail.to).toBe("buyer@example.invalid");
    expect(mail.kind).toBe("razorpay_payment_failed_retry");
    expect(mail.text).toContain(`/quote/${QUOTE}/accept?t=tok_aitest`);
    expect(mail.text).toContain("nothing was charged");
  });

  it("a failure after the quote was paid is ignored", async () => {
    db.tables.quotes[0].payment_status = "invoiced";
    db.tables.quotes[0].invoice_id = "INV-AITEST-0001";
    const res = await POST(signed(failed()));
    expect((await res.json()).ignored).toMatch(/already paid/);
    expect(db.tables.lead_activities).toHaveLength(0);
  });

  it("an unsigned failure event is rejected before anything is written", async () => {
    const r = signed(failed());
    const forged = new NextRequest(r.url, { method: "POST", headers: { "x-razorpay-signature": "00" }, body: JSON.stringify(failed()) });
    const res = await POST(forged);
    expect(res.status).toBe(401);
    expect(db.tables.lead_activities).toHaveLength(0);
  });
});

describe("S24 — one payment, one run; a global-secret event cannot reach a tenant with its own secret", () => {
  it("payment.captured and order.paid arriving TOGETHER run the invoice, provisioning and emails once", async () => {
    const [a, b] = await Promise.all([POST(signed(captured())), POST(signed(captured("order.paid")))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = [await a.json(), await b.json()];
    expect(bodies.filter((x) => x.alreadyProcessed)).toHaveLength(1);
    expect(rpcNames().filter((n) => n === "generate_invoice")).toHaveLength(1);
    expect(db.tables.payments).toHaveLength(1);
    expect(queueProvisioning.mock.calls.length).toBeLessThanOrEqual(1);
    const customerMails = sendEmail.mock.calls.filter((c) => (c[0] as { kind: string }).kind === "razorpay_payment_customer");
    expect(customerMails).toHaveLength(1);
  });

  it("no ?tenant=, signed with the global secret, on a tenant that HAS its own secret is refused, nothing recorded", async () => {
    const res = await POST(signed(captured(), { secret: GLOBAL_SECRET, tenant: null }));
    expect(res.status).toBe(403);
    expect(rpcNames()).toEqual([]);
    expect(db.tables.payments).toHaveLength(0);
  });

  it("?tenant= of a tenant with no secret (falls back to global) cannot settle another tenant's quote", async () => {
    const res = await POST(signed(captured(), { secret: GLOBAL_SECRET, tenant: "22222222-2222-4222-8222-222222222222" }));
    expect(res.status).toBe(403);
    expect(rpcNames()).toEqual([]);
  });

  it("the global secret still settles a tenant that has no secret of its own (the checkout env-key fallback)", async () => {
    db.tables.tenant_secrets = [];
    const res = await POST(signed(captured(), { secret: GLOBAL_SECRET, tenant: null }));
    expect(res.status).toBe(200);
    expect(rpcNames()[0]).toBe("record_payment");
  });

  it("payment.failed signed with the global secret cannot write on a tenant with its own secret", async () => {
    const res = await POST(signed(failed(), { secret: GLOBAL_SECRET, tenant: null }));
    expect(res.status).toBe(403);
    expect(db.tables.lead_activities).toHaveLength(0);
  });
});

describe("R-033 — each provisioning row carries its own share of the payment", () => {
  it("two domains in one order: each row gets its line's part, not the whole ₹1,180", async () => {
    db.tables.quotes[0].line_items = [
      { id: "l1", name: "Domain a.in", qty: 1, rate: 600, cost: 0, domain: "a.in" },
      { id: "l2", name: "Domain b.in", qty: 1, rate: 400, cost: 0, domain: "b.in" },
    ];
    const res = await POST(signed(captured()));
    expect(res.status).toBe(200);
    const rows = queueProvisioning.mock.calls.map((c) => (c as unknown as [{ domain: string; amountPaid: number }])[0]);
    const byDomain = Object.fromEntries(rows.map((r) => [r.domain, r.amountPaid]));
    expect(byDomain).toEqual({ "a.in": 708, "b.in": 472 });
  });
});

/* ── R-045: what Razorpay kept, and refunds ──────────────────────────────── */

const capturedWithFee = (event = "payment.captured") => {
  const e = captured(event);
  Object.assign(e.payload.payment.entity, { fee: 2786, tax: 425 }); // ₹27.86 incl. ₹4.25 GST
  return e;
};

const refundEvt = (refundId = "rfnd_AITEST1", amountPaise = 118000, payId = "pay_AITEST1") => ({
  event: "refund.processed",
  created_at: 2,
  payload: {
    refund: { entity: { id: refundId, payment_id: payId, amount: amountPaise, currency: "INR", status: "processed" } },
    payment: { entity: { id: payId, order_id: "order_AITEST1", amount: 118000, currency: "INR", status: "refunded", method: "card" } },
  },
});

const payRow = () => db.tables.payments.find((r) => r.reference === "pay_AITEST1")!;
const leadNotes = () => db.tables.lead_activities.map((r) => String(r.detail));
const refundNotices = () => vi.mocked(notifyTenantOwners).mock.calls.map((c) => c[0]).filter((n) => n.kind === "payment.refunded");

describe("R-045 — Razorpay's fee is kept on the payment", () => {
  it("payment.captured stores fee + GST on fee in whole rupees; the gross amount is unchanged", async () => {
    const res = await POST(signed(capturedWithFee()));
    expect(res.status).toBe(200);
    expect(payRow().amount).toBe(1180);
    expect(payRow().gateway_fee).toBe(28);
    expect(payRow().gateway_fee_gst).toBe(4);
  });

  it("an order.paid that arrived first without a fee is filled in by the later payment.captured", async () => {
    await POST(signed(captured("order.paid")));
    expect(payRow().gateway_fee).toBeUndefined();
    const again = await POST(signed(capturedWithFee()));
    expect((await again.json()).alreadyProcessed).toBe(true);
    expect(payRow().gateway_fee).toBe(28);
    expect(rpcNames().filter((n) => n === "record_payment")).toHaveLength(1);
  });

  it("slice 2: the fee is booked as an expense for THIS payment, in THIS tenant", async () => {
    bookGatewayFeeExpense.mockClear();
    await POST(signed(capturedWithFee()));
    expect(bookGatewayFeeExpense).toHaveBeenCalledTimes(1);
    const [, tenant, paymentId] = bookGatewayFeeExpense.mock.calls[0];
    expect(tenant).toBe(TENANT);
    expect(paymentId).toBe(payRow().id);
  });

  it("slice 2: a booking failure never fails the webhook (the payment is committed)", async () => {
    bookGatewayFeeExpense.mockClear();
    bookGatewayFeeExpense.mockResolvedValueOnce("error");
    const res = await POST(signed(capturedWithFee()));
    expect(res.status).toBe(200);
    expect(payRow().gateway_fee).toBe(28);
  });

  it("slice 2: no fee in the event → nothing to book", async () => {
    bookGatewayFeeExpense.mockClear();
    await POST(signed(captured()));
    expect(bookGatewayFeeExpense).not.toHaveBeenCalled();
  });

  it("no fee in the event: nothing guessed", async () => {
    await POST(signed(captured()));
    expect(payRow().gateway_fee).toBeUndefined();
  });
});

describe("R-045 — refund.processed leaves an instruction, once, and books nothing", () => {
  beforeEach(() => vi.mocked(notifyTenantOwners).mockClear());

  it("invoiced quote: note says credit note first; payment status untouched; no RPC", async () => {
    await POST(signed(captured()));
    const rpcsBefore = db.rpcCalls.length;
    const res = await POST(signed(refundEvt()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refund).toBe("rfnd_AITEST1");
    expect(body.partial).toBe(false);
    expect(body.nextStep).toContain("credit note");
    expect(body.nextStep).toContain("INV-AITEST-0001");
    expect(payRow().status).toBe("received");
    expect(payRow().gateway_refund_ids).toEqual(["rfnd_AITEST1"]);
    expect(db.rpcCalls.length).toBe(rpcsBefore);
    expect(leadNotes().some((n) => n.includes("rfnd_AITEST1") && n.includes("credit note"))).toBe(true);
    expect(refundNotices()).toHaveLength(1);
    expect(refundNotices()[0]).toMatchObject({ tenantId: TENANT, href: `/quotes/${QUOTE}` });
  });

  it("the same refund delivered twice writes one note and one notification", async () => {
    await POST(signed(captured()));
    await POST(signed(refundEvt()));
    const notes = leadNotes().length;
    const again = await POST(signed(refundEvt()));
    expect((await again.json()).alreadyProcessed).toBe(true);
    expect(leadNotes().length).toBe(notes);
    expect(refundNotices()).toHaveLength(1);
  });

  it("a second, different partial refund on the same payment is noted too", async () => {
    await POST(signed(captured()));
    const a = await (await POST(signed(refundEvt("rfnd_AITESTA", 50000)))).json();
    const b = await (await POST(signed(refundEvt("rfnd_AITESTB", 20000)))).json();
    expect(a.partial).toBe(true);
    expect(a.amount).toBe(500);
    expect(b.amount).toBe(200);
    expect(payRow().gateway_refund_ids).toEqual(["rfnd_AITESTA", "rfnd_AITESTB"]);
  });

  it("a refund for a payment the app never recorded is acknowledged and ignored", async () => {
    const res = await POST(signed(refundEvt("rfnd_AITESTX", 1000, "pay_UNKNOWN")));
    expect(res.status).toBe(200);
    expect((await res.json()).ignored).toMatch(/unknown payment/);
    expect(vi.mocked(notifyTenantOwners)).not.toHaveBeenCalled();
  });

  it("another tenant's secret cannot act on this tenant's payment", async () => {
    await POST(signed(captured()));
    const OTHER = "22222222-2222-4222-8222-222222222222";
    db.tables.tenant_secrets.push({ tenant_id: OTHER, razorpay_webhook_secret: "whsec_other", razorpay_key_id: "rzp_test_o" });
    const res = await POST(signed(refundEvt(), { secret: "whsec_other", tenant: OTHER }));
    expect(res.status).toBe(403);
    expect(payRow().gateway_refund_ids).toBeUndefined();
  });

  it("a bad signature is still refused", async () => {
    expect((await POST(signed(refundEvt(), { secret: "whsec_wrong" }))).status).toBe(401);
  });
});
