/**
 * R-2415 — payment_link.paid for a Send-reminder pay link books the invoice ONCE.
 *
 * Signed, mocked Razorpay events (the HMAC is the same check as every other event):
 *  - a verified payment_link.paid → settle_invoice_payment_link with the link id, payment id and
 *    the paise Razorpay captured; fee + bearer on the payment row; owner told; no customer email;
 *  - the same event again → already processed, nothing more;
 *  - a bad signature → 401, nothing booked;
 *  - another tenant's link under this tenant's secret → 403, nothing booked;
 *  - the settle RPC says review → owner told to check, nothing booked;
 *  - the payment.captured / order.paid of the same money is left to payment_link.paid (no
 *    "quote not found" review, no record_payment).
 */
import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
vi.hoisted(() => { process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_global_r2415"; });
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
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return q; },
      limit: (n: number) => { lim = n; return q; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: rows()[0] ? null : { message: "not found" } }),
      update: (patch: Row) => { pendingUpdate = patch; return q; },
      insert: async (row: Row) => { (db.tables[table] ??= []).push({ ...row }); return { data: null, error: null }; },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        const matched = rows();
        if (pendingUpdate) for (const r of matched) Object.assign(r, pendingUpdate);
        return Promise.resolve({ data: matched, error: null }).then(ok, bad);
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
const sendEmail = vi.hoisted(() => vi.fn(async () => ({ status: "stubbed", providerId: null, errorMessage: null, provider: "stub" })));
vi.mock("@/lib/email/send", () => ({ sendEmail }));
vi.mock("@/lib/razorpay/fee-expense.server", () => ({ bookGatewayFeeExpense: vi.fn(async () => "booked") }));
vi.mock("@/lib/automation/gate.server", () => ({
  automationState: async () => "on", cronTenants: async () => ({ on: [], dry: [] }), recordRun: async () => {},
  readJobRow: async () => null, ensureDefaultOnRow: async () => {}, readTenantJobs: async () => [],
}));

import { POST } from "./route";
import { notifyTenantOwners } from "@/lib/notifications/notify.server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SECRET = "whsec_r2415";
const ROW = "0e9d0c0a-1b2c-4d5e-8f90-a1b2c3d4e5f6";

function seed(linkTenant = TENANT) {
  db.tables = {
    tenant_secrets: [{ tenant_id: TENANT, razorpay_webhook_secret: SECRET, razorpay_key_id: "rzp_test_r2415" }],
    invoice_payment_links: [{ id: ROW, tenant_id: linkTenant, customer_id: "c1", razorpay_link_id: "plink_R2415abc", razorpay_order_id: null, status: "active" }],
    payments: [{ id: "pay-row", tenant_id: TENANT, quote_id: "Q-1", reference: "pay_R2415one", fee_bearer: null }],
    quotes: [],
  };
  db.rpcCalls = [];
  let booked = false;
  db.rpcImpl = (name) => {
    if (name !== "settle_invoice_payment_link") return { data: null, error: null };
    if (booked) return { data: { found: true, already_recorded: true, tenant_id: TENANT }, error: null };
    booked = true;
    return {
      data: {
        found: true, recorded: true, tenant_id: TENANT, customer_id: "c1",
        lines: [{ invoice_id: "INV-1", quote_id: "Q-1", amount: 11_800, payment_id: "pay-row", invoice_paid: true }],
      },
      error: null,
    };
  };
}

function signed(event: Row, secret = SECRET) {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return new NextRequest(`https://shop.example.invalid/api/webhooks/razorpay?tenant=${TENANT}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-razorpay-signature": sig, "x-razorpay-event-id": "evt_r2415" },
    body: raw,
  });
}

const linkPaid = () => ({
  event: "payment_link.paid",
  created_at: 1,
  payload: {
    payment_link: { entity: { id: "plink_R2415abc", status: "paid", amount: 1_180_000, amount_paid: 1_180_000, notes: { tenant_id: TENANT, purpose: "invoice_payment_link", link_row: ROW } } },
    payment: { entity: { id: "pay_R2415one", order_id: "order_R2415one", amount: 1_180_000, currency: "INR", status: "captured", method: "upi", fee: 2_360, tax: 360, notes: [] } },
    order: { entity: { id: "order_R2415one", receipt: ROW, amount: 1_180_000, notes: { purpose: "invoice_payment_link" } } },
  },
});

describe("payment_link.paid (R-2415)", () => {
  beforeEach(() => { seed(); vi.mocked(notifyTenantOwners).mockClear(); sendEmail.mockClear(); });

  it("books the invoice through settle_invoice_payment_link with what Razorpay captured", async () => {
    const res = await POST(signed(linkPaid()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recorded: true, invoices: ["INV-1"] });
    const settle = db.rpcCalls.filter((c) => c.name === "settle_invoice_payment_link");
    expect(settle).toHaveLength(1);
    expect(settle[0].args).toEqual({ p_link_id: "plink_R2415abc", p_payment_id: "pay_R2415one", p_paid_paise: 1_180_000, p_event_id: "evt_r2415" });
    expect(db.rpcCalls.some((c) => c.name === "record_payment")).toBe(false);   // only through settle
    expect(db.tables.invoice_payment_links[0].razorpay_order_id).toBe("order_R2415one");
    expect(db.tables.payments[0]).toMatchObject({ gateway_fee: 24, gateway_fee_gst: 4 });
    expect(notifyTenantOwners).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled();                                     // we send reminders; nothing to the customer here
  });

  it("the same event twice → booked once", async () => {
    await POST(signed(linkPaid()));
    const again = await POST(signed(linkPaid()));
    expect(await again.json()).toMatchObject({ alreadyProcessed: true });
    expect(notifyTenantOwners).toHaveBeenCalledTimes(1);
  });

  it("a bad signature is refused before anything is read", async () => {
    const res = await POST(signed(linkPaid(), "whsec_wrong"));
    expect(res.status).toBe(401);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("another tenant's link under this tenant's secret → 403, nothing booked", async () => {
    seed(OTHER);
    const res = await POST(signed(linkPaid()));
    expect(res.status).toBe(403);
    expect(db.rpcCalls.some((c) => c.name === "settle_invoice_payment_link")).toBe(false);
  });

  it("settle says review → owner told, nothing booked", async () => {
    db.rpcImpl = () => ({ data: { found: true, review: true, tenant_id: TENANT, why: "invoice INV-1 is already paid" }, error: null });
    const res = await POST(signed(linkPaid()));
    expect(await res.json()).toMatchObject({ needsReview: true });
    const call = vi.mocked(notifyTenantOwners).mock.calls[0][0];
    expect(call.body).toContain("invoice INV-1 is already paid");
    expect(call.body).toContain("pay_R2415one");
  });

  it("a link the app did not make is acknowledged, not booked", async () => {
    db.tables.invoice_payment_links = [];
    const res = await POST(signed(linkPaid()));
    expect(await res.json()).toMatchObject({ ignored: expect.stringContaining("not an app invoice link") });
  });

  it("payment.captured / order.paid of the same money are left to payment_link.paid", async () => {
    const body = linkPaid();
    for (const event of ["payment.captured", "order.paid"]) {
      const res = await POST(signed({ ...body, event }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ignored: expect.stringContaining("reminder pay link") });
    }
    expect(db.rpcCalls).toHaveLength(0);
    expect(notifyTenantOwners).not.toHaveBeenCalled();
  });

  it("a payment.captured without our notes is still recognised by the order id stored at payment_link.paid", async () => {
    await POST(signed(linkPaid()));
    db.rpcCalls = [];
    const bare = { event: "payment.captured", created_at: 1, payload: { payment: { entity: { id: "pay_R2415one", order_id: "order_R2415one", amount: 1_180_000, currency: "INR", status: "captured", method: "upi", notes: [] } } } };
    const res = await POST(signed(bare));
    expect(await res.json()).toMatchObject({ ignored: expect.stringContaining("reminder pay link") });
    expect(db.rpcCalls).toHaveLength(0);
  });
});
