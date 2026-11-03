/**
 * R-2415 — the IO half of the invoice pay link: made once, reused, replaced when the amount
 * changes, cancelled when the bill was paid another way. Razorpay HTTP is mocked; the DB is a
 * small in-memory fake that keeps the one-live-link-per-bill rule like the unique index does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => { throw new Error("pass admin"); } }));
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: (r: unknown) => r }));
vi.mock("@/lib/messaging", () => ({ sendCustomerEmail: vi.fn() }));
vi.mock("@/lib/checkout/live-guards", () => ({ liveKeyCheckoutRefusal: () => null }));

import { getOrCreateInvoicePayLink, sweepStaleInvoicePayLinks } from "./payment-link.server";
import { INVOICE_LINK_PURPOSE } from "./payment-link";

type Row = Record<string, unknown>;
const T = "aaaaaaaa-0000-0000-0000-000000000001";
const C = "cccccccc-0000-0000-0000-000000000001";

function fakeDb(tables: Record<string, Row[]>, fail: { read?: string; update?: string } = {}) {
  let seq = 0;
  const from = (table: string) => {
    const rows = (tables[table] ??= []);
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "update" | "insert" = "select";
    let patch: Row = {};
    let inserted: Row | null = null;
    let lim = Infinity;
    const run = () => {
      if (op === "insert") return { data: inserted, error: inserted ? null : { code: "23505" } };
      if (op === "select" && fail.read === table) return { data: null, error: { message: "boom" } };
      if (op === "update" && fail.update === table) return { data: null, error: { message: "boom" } };
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") { hit.forEach((r) => Object.assign(r, patch)); return { data: hit, error: null }; }
      return { data: hit.slice(0, lim), error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
      in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return b; },
      lt: (k: string, v: unknown) => { filters.push((r) => r[k] != null && String(r[k]) < String(v)); return b; },
      order: () => b,
      limit: (n: number) => { lim = n; return b; },
      update: (p: Row) => { op = "update"; patch = p; return b; },
      insert: (r: Row) => {
        op = "insert";
        const clash = table === "invoice_payment_links" && rows.some((x) =>
          x.tenant_id === r.tenant_id && x.link_key === r.link_key && (x.status === "creating" || x.status === "active"));
        if (!clash) { inserted = { id: `row-${++seq}`, created_at: new Date().toISOString(), ...r }; rows.push(inserted); }
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: run().data && (run().data as Row[])[0] ? (run().data as Row[])[0] : null, error: null }),
      single: () => Promise.resolve(op === "insert" ? run() : { data: (run().data as Row[])[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  return { from, tables };
}

function razorpay() {
  let n = 0;
  const calls: { url: string; body: Row | null }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : null;
    calls.push({ url, body });
    if (url.endsWith("/payment_links")) {
      n += 1;
      return new Response(JSON.stringify({ id: `plink_TEST${String(n).padStart(6, "0")}`, short_url: `https://rzp.io/i/t${n}` }), { status: 200 });
    }
    if (url.endsWith("/cancel")) return new Response("{}", { status: 200 });
    return new Response("{}", { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function world(extra: { due?: number; status?: string; keys?: boolean } = {}) {
  return fakeDb({
    tenant_secrets: extra.keys === false ? [] : [{ tenant_id: T, razorpay_key_id: "rzp_test_xxx", razorpay_key_secret: "s" }],
    invoices: [{
      id: "INV-1", tenant_id: T, customer_id: C, quote_id: "Q-1", currency: "INR", status: extra.status ?? "overdue",
      amount: 11_800, net_payable: 11_800, paid_amount: 11_800 - (extra.due ?? 11_800),
    }],
    quotes: [{ id: "Q-1", tenant_id: T, invoice_id: "INV-1" }],
    invoice_payment_links: [],
  });
}

const ask = (db: ReturnType<typeof fakeDb>, fetchImpl: typeof fetch, amountDue = 11_800) =>
  getOrCreateInvoicePayLink({
    tenantId: T, customerId: C, scope: "invoice",
    lines: [{ kind: "invoice", id: "INV-1", amountDue }],
    sellerName: "Acme", customerName: "Buyer", customerEmail: "b@x.in", customerPhone: null,
    admin: db as never, fetchImpl, nowMs: Date.parse("2026-11-03T14:00:00Z"),
  });

describe("getOrCreateInvoicePayLink", () => {
  let rz: ReturnType<typeof razorpay>;
  beforeEach(() => { rz = razorpay(); });

  it("first Send reminder makes ONE link for the bill amount, Razorpay told to send nothing", async () => {
    const db = world();
    const out = await ask(db, rz.fetchImpl);
    expect(out.link).toEqual({ url: "https://rzp.io/i/t1", amount: 11_800, billAmount: 11_800, mode: "test" });
    const create = rz.calls.find((c) => c.url.endsWith("/payment_links"));
    expect(create?.body?.amount).toBe(1_180_000);
    expect(create?.body?.notify).toEqual({ sms: false, email: false });
    expect(create?.body?.reminder_enable).toBe(false);
    expect((create?.body?.notes as Row).purpose).toBe(INVOICE_LINK_PURPOSE);
    const rows = db.tables.invoice_payment_links;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "active", razorpay_link_id: "plink_TEST000001", link_key: "invoice:INV-1", amount: 11_800, bill_amount: 11_800 });
  });

  it("opening it again reuses the same link — no second Razorpay call", async () => {
    const db = world();
    const a = await ask(db, rz.fetchImpl);
    const b = await ask(db, rz.fetchImpl);
    expect(b.link?.url).toBe(a.link?.url);
    expect(rz.calls.filter((c) => c.url.endsWith("/payment_links"))).toHaveLength(1);
    expect(db.tables.invoice_payment_links).toHaveLength(1);
  });

  it("amount changed (part paid) → old link cancelled at Razorpay, a new one for the new amount", async () => {
    const db = world();
    await ask(db, rz.fetchImpl);
    const inv = db.tables.invoices[0];
    inv.paid_amount = 5_000;                         // ₹6,800 still due
    const out = await ask(db, rz.fetchImpl, 6_800);
    expect(out.link).toMatchObject({ url: "https://rzp.io/i/t2", amount: 6_800 });
    expect(rz.calls.some((c) => c.url.endsWith("/plink_TEST000001/cancel"))).toBe(true);
    const rows = db.tables.invoice_payment_links;
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "active"]);
  });

  it("someone else is making it right now → busy, no second link", async () => {
    const db = world();
    db.tables.invoice_payment_links.push({
      id: "row-x", tenant_id: T, link_key: "invoice:INV-1", status: "creating", amount: 11_800, bill_amount: 11_800,
      allocations: [{ invoice_id: "INV-1", quote_id: "Q-1", amount: 11_800 }], created_at: "2026-11-03T13:59:50Z", expires_at: null,
    });
    const out = await ask(db, rz.fetchImpl);
    expect(out.link).toBeNull();
    expect(out.notice?.reason).toBe("busy");
    expect(rz.calls).toHaveLength(0);
  });

  it("Razorpay not connected → no link, notice points to Settings", async () => {
    const out = await ask(world({ keys: false }), rz.fetchImpl);
    expect(out.link).toBeNull();
    expect(out.notice?.reason).toBe("not_configured");
  });

  it("Razorpay refuses → row failed, notice with Razorpay's words; never throws", async () => {
    const db = world();
    const bad = vi.fn(async () => new Response(JSON.stringify({ error: { description: "Authentication failed" } }), { status: 401 }));
    const out = await ask(db, bad as unknown as typeof fetch);
    expect(out.notice?.reason).toBe("gateway_error");
    expect(out.notice?.text).toContain("Authentication failed");
    expect(db.tables.invoice_payment_links[0].status).toBe("failed");
  });

  it("an old link that cannot be cancelled (maybe just paid) → no new link", async () => {
    const db = world();
    await ask(db, rz.fetchImpl);
    db.tables.invoices[0].paid_amount = 5_000;
    const stuck = vi.fn(async (url: string) =>
      url.endsWith("/cancel") ? new Response("{}", { status: 400 })
        : url.includes("/payment_links/") ? new Response(JSON.stringify({ status: "paid" }), { status: 200 })
          : new Response("{}", { status: 500 }));
    const out = await ask(db, stuck as unknown as typeof fetch, 6_800);
    expect(out.link).toBeNull();
    expect(out.notice?.reason).toBe("gateway_error");
    expect(db.tables.invoice_payment_links.filter((r) => r.status === "active")).toHaveLength(1);
  });
});

describe("sweepStaleInvoicePayLinks — bill paid / credited another way", () => {
  it("cancels the link of a bill that is paid now, leaves an open one", async () => {
    const rz = razorpay();
    const db = world();
    await ask(db, rz.fetchImpl);
    db.tables.invoices[0].status = "paid";
    db.tables.invoices[0].paid_amount = 11_800;
    const out = await sweepStaleInvoicePayLinks({ admin: db as never, fetchImpl: rz.fetchImpl });
    expect(out).toEqual({ checked: 1, cancelled: 1 });
    expect(db.tables.invoice_payment_links[0]).toMatchObject({ status: "cancelled", cancel_reason: "bill paid or closed" });
  });

  it("an open bill keeps its link", async () => {
    const rz = razorpay();
    const db = world();
    await ask(db, rz.fetchImpl);
    const out = await sweepStaleInvoicePayLinks({ admin: db as never, fetchImpl: rz.fetchImpl });
    expect(out.cancelled).toBe(0);
    expect(db.tables.invoice_payment_links[0].status).toBe("active");
  });
});


describe("R-2415 review fixes", () => {
  it("sweep: a failed invoices read cancels NOTHING (never reads as every bill gone)", async () => {
    const rz = razorpay();
    const db = world();
    await ask(db, rz.fetchImpl);
    const broken = fakeDb(db.tables, { read: "invoices" });
    const out = await sweepStaleInvoicePayLinks({ admin: broken as never, fetchImpl: rz.fetchImpl });
    expect(out.cancelled).toBe(0);
    expect(db.tables.invoice_payment_links[0].status).toBe("active");
    expect(rz.calls.some((c) => c.url.endsWith("/cancel"))).toBe(false);
  });

  it("sweep: a link past its Razorpay expiry is closed without an API call", async () => {
    const rz = razorpay();
    const db = world();
    await ask(db, rz.fetchImpl);
    const later = Date.parse("2026-12-10T00:00:00Z");
    await sweepStaleInvoicePayLinks({ admin: db as never, fetchImpl: rz.fetchImpl, nowMs: later });
    expect(db.tables.invoice_payment_links[0]).toMatchObject({ status: "cancelled", cancel_reason: "expired" });
  });

  it("sweep: the cron's tenant gate is honoured", async () => {
    const rz = razorpay();
    const db = world();
    await ask(db, rz.fetchImpl);
    db.tables.invoices[0].status = "paid";
    const out = await sweepStaleInvoicePayLinks({ admin: db as never, fetchImpl: rz.fetchImpl, tenantAllowed: () => false });
    expect(out.cancelled).toBe(0);
  });

  it("sweep: a written-off bill's link is cancelled", async () => {
    const rz = razorpay();
    const db = world();
    await ask(db, rz.fetchImpl);
    db.tables.invoices[0].written_off_at = "2026-11-03T10:00:00Z";
    const out = await sweepStaleInvoicePayLinks({ admin: db as never, fetchImpl: rz.fetchImpl });
    expect(out.cancelled).toBe(1);
  });

  it("key changed test → live: the test link is retired and a live one made, never reused", async () => {
    const rz = razorpay();
    const db = world();
    await ask(db, rz.fetchImpl);
    db.tables.tenant_secrets[0].razorpay_key_id = "rzp_live_xxx";
    const out = await ask(db, rz.fetchImpl);
    expect(out.link).toMatchObject({ url: "https://rzp.io/i/t2", mode: "live" });
    expect(db.tables.invoice_payment_links.map((r) => [r.status, r.mode])).toEqual([["cancelled", "test"], ["active", "live"]]);
  });

  it("a link that could not be saved is cancelled and never handed out", async () => {
    const rz = razorpay();
    const db = fakeDb(world().tables, { update: "invoice_payment_links" });
    const out = await ask(db, rz.fetchImpl);
    expect(out.link).toBeNull();
    expect(out.notice?.reason).toBe("gateway_error");
    expect(rz.calls.some((c) => c.url.endsWith("/plink_TEST000001/cancel"))).toBe(true);
  });
});
