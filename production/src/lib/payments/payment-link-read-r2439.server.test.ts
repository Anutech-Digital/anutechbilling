/**
 * R-2439 (review of R-2415, item 2) — READING a pay link never makes or cancels one.
 *
 * GET /api/customers/{id}/pending-dues used to call getOrCreateInvoicePayLink, so a prefetch or a
 * reload could make a link at Razorpay, or cancel the live link a customer already had. Now the
 * read (`readOnly: true`) only returns the live link while it still fits the bills; it never calls
 * Razorpay and never writes a row. Making / replacing stays with the explicit POST.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => { throw new Error("pass admin"); } }));
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: (r: unknown) => r }));
vi.mock("@/lib/messaging", () => ({ sendCustomerEmail: vi.fn() }));
vi.mock("@/lib/checkout/live-guards", () => ({ liveKeyCheckoutRefusal: () => null }));

import { getOrCreateInvoicePayLink } from "./payment-link.server";

type Row = Record<string, unknown>;
const T = "aaaaaaaa-0000-0000-0000-000000000001";
const C = "cccccccc-0000-0000-0000-000000000001";
const NOW = Date.parse("2026-11-03T14:00:00Z");

/** In-memory DB that counts every write. */
function fakeDb(tables: Record<string, Row[]>) {
  const writes: string[] = [];
  const from = (table: string) => {
    const rows = (tables[table] ??= []);
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "update" | "insert" = "select";
    let patch: Row = {};
    const run = () => {
      if (op === "insert") return { data: { id: "row-new" }, error: null };
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") { hit.forEach((r) => Object.assign(r, patch)); return { data: hit, error: null }; }
      return { data: hit, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
      in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return b; },
      lt: (k: string, v: unknown) => { filters.push((r) => r[k] != null && String(r[k]) < String(v)); return b; },
      order: () => b,
      limit: () => b,
      update: (p: Row) => { op = "update"; patch = p; writes.push(`update ${table}`); return b; },
      insert: () => { op = "insert"; writes.push(`insert ${table}`); return b; },
      maybeSingle: () => Promise.resolve({ data: (run().data as Row[])[0] ?? null, error: null }),
      single: () => Promise.resolve(op === "insert" ? run() : { data: (run().data as Row[])[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  return { from, tables, writes };
}

function world(link?: Row) {
  return fakeDb({
    tenant_secrets: [{ tenant_id: T, razorpay_key_id: "rzp_test_xxx", razorpay_key_secret: "s" }],
    invoices: [{ id: "INV-1", tenant_id: T, customer_id: C, quote_id: "Q-1", currency: "INR", status: "overdue", amount: 11_800, net_payable: 11_800, paid_amount: 0 }],
    quotes: [{ id: "Q-1", tenant_id: T, invoice_id: "INV-1" }],
    invoice_payment_links: link ? [link] : [],
  });
}

const live = (amount: number): Row => ({
  id: "row-1", tenant_id: T, customer_id: C, link_key: `statement:${C}`, status: "active", mode: "test",
  amount, bill_amount: amount, allocations: [{ invoice_id: "INV-1", quote_id: "Q-1", amount }],
  razorpay_link_id: "plink_LIVE000001", short_url: "https://rzp.io/i/live1", created_at: "2026-11-01T10:00:00Z",
  expires_at: "2026-12-30T00:00:00Z",
});

const read = (db: ReturnType<typeof fakeDb>, fetchImpl: typeof fetch, amountDue = 11_800) =>
  getOrCreateInvoicePayLink({
    tenantId: T, customerId: C, scope: "statement",
    lines: [{ kind: "invoice", id: "INV-1", amountDue }],
    sellerName: "Acme", customerName: "Buyer", customerEmail: null, customerPhone: null,
    admin: db as never, fetchImpl, nowMs: NOW, readOnly: true,
  });

describe("getOrCreateInvoicePayLink readOnly (R-2439)", () => {
  it("no link yet → none is made: no Razorpay call, no row; the notice says it is made on Send reminder", async () => {
    const db = world();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const out = await read(db, fetchImpl as unknown as typeof fetch);
    expect(out.link).toBeNull();
    expect(out.notice?.reason).toBe("not_made");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it("the live link still fits the bills → returned as is", async () => {
    const db = world(live(11_800));
    const fetchImpl = vi.fn();
    const out = await read(db, fetchImpl as unknown as typeof fetch);
    expect(out.link).toEqual({ url: "https://rzp.io/i/live1", amount: 11_800, billAmount: 11_800, mode: "test" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it("the amount changed → the customer's live link is NOT cancelled by a read (no link shown, nothing written)", async () => {
    const db = world(live(11_800));
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const out = await read(db, fetchImpl as unknown as typeof fetch, 6_800);
    expect(out.link).toBeNull();
    expect(out.notice?.reason).toBe("not_made");
    expect(fetchImpl).not.toHaveBeenCalled();                    // no /cancel, no new link
    expect(db.writes).toEqual([]);
    expect(db.tables.invoice_payment_links[0].status).toBe("active");
  });
});

describe("readOnly while another request is making the link (R-2439 review)", () => {
  it("a 'creating' row → no link and the read's own notice (not 'press Draft again'); nothing written", async () => {
    const db = world({ ...live(11_800), status: "creating", razorpay_link_id: null, short_url: null, created_at: "2026-11-03T13:59:50Z" });
    const fetchImpl = vi.fn();
    const out = await read(db, fetchImpl as unknown as typeof fetch);
    expect(out.link).toBeNull();
    expect(out.notice?.reason).toBe("not_made");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });
});
