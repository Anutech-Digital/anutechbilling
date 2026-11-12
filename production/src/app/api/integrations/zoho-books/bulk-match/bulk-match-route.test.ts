/**
 * R-2402 — POST /api/integrations/zoho-books/bulk-match ("Reconcile from Zoho", bulk): owner /
 * accountant only; only the caller's OWN tenant's unmatched money-in lines of the account; a line
 * from elsewhere (or booked meanwhile) is skipped, never planned; one cached Zoho read of the window,
 * Zoho calls counted for pacing; a new customer's Zoho contact is read; nothing is written.
 * Zoho is a fake fetch; the connection store is mocked; values are made up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const TENANT = "11111111-0000-4000-8000-00000000e1ce";
const ACCOUNT = "55555555-0000-4000-8000-000000000001";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const L2 = "aaaaaaaa-0000-4000-8000-000000000002";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000009";

const st = vi.hoisted(() => ({
  role: "owner" as string | null,
  conn: { refreshToken: "rt" as string | null, orgId: "600" as string | null, orgName: "Org", connectedAt: null },
  lines: [] as Array<Record<string, unknown>>,
  /* R-2658: what the rival read (the company's remittance lines — the query with .or) answers; null = st.lines. */
  rivalLines: null as Array<Record<string, unknown>> | null,
  rivalOr: [] as string[],
  rivalRanges: [] as Array<[number, number]>,
  customers: [] as Array<Record<string, unknown>>,
  filters: [] as Array<[string, string, string, unknown]>,
  writes: 0,
  busyOn: null as string | null,
  /* R-2419: the facts reads — rows per table, and the user-session RPC calls. */
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  /* R-2621: the admin (service-role) RPC calls — gst_filed_days — and its answer. */
  adminRpcs: [] as Array<[string, Record<string, unknown>]>,
  gstFiled: [] as string[],
  gstFiledError: false,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      st.rpcs.push([fn, args]);
      return { data: fn === "bank_credit_open_items" ? (st.tables["open_items"] ?? []) : null, error: null };
    },
  }),
}));

vi.mock("@/lib/integrations/zoho-books/store", () => ({
  resolveZohoCaller: async () => (st.role === null ? null : {
    userId: "u1", tenantId: TENANT, role: st.role, canManage: true,
    admin: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        st.adminRpcs.push([fn, args]);
        if (st.gstFiledError) return { data: null, error: { message: "boom" } };
        return { data: fn === "gst_filed_days" ? st.gstFiled : null, error: null };
      },
      from: (table: string) => {
        let rows = table === "customers" ? st.customers : table === "bank_transactions" ? st.lines : (st.tables[table] ?? []);
        let rival = false;
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (k: string, v: unknown) => { st.filters.push([table, "eq", k, v]); return q; },
          is: (k: string, v: unknown) => { st.filters.push([table, "is", k, v]); return q; },
          gt: (k: string, v: unknown) => { st.filters.push([table, "gt", k, v]); return q; },
          in: (k: string, v: unknown) => { st.filters.push([table, "in", k, v]); return q; },
          not: () => q, gte: () => q, lte: () => q, limit: () => q,
          or: (f: string) => { if (table === "bank_transactions") { rival = true; st.rivalOr.push(f); if (st.rivalLines) rows = st.rivalLines; } return q; },
          order: () => q,
          range: async (a: number, b: number) => { if (rival) st.rivalRanges.push([a, b]); return { data: rows.slice(a, b + 1), error: null }; },
          then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
          update: () => { st.writes += 1; return q; },
          insert: () => { st.writes += 1; return q; },
        };
        return q;
      },
    },
  }),
  readConnection: async () => st.conn,
  zohoAccessToken: async () => "access",
  dropZohoAccessToken: async () => {},
}));

import { POST } from "./route";
import { clearZohoBatchCache } from "@/lib/integrations/zoho-books/payment-batch";

const zohoCalls: string[] = [];
/* R-2658: a test's own Zoho payment list (null = the R-2402 one below). */
const r2658 = { payments: null as Array<Record<string, unknown>> | null };
const json = (b: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify({ code: 0, ...(b as object) }), { status }));
function fakeFetch(input: string | URL | Request) {
  const url = new URL(String(input));
  zohoCalls.push(url.pathname);
  if (st.busyOn && url.pathname.includes(st.busyOn)) {
    return Promise.resolve(new Response(JSON.stringify({ code: 44, message: "too many requests" }), { status: 429 }));
  }
  if (url.pathname.endsWith("/customerpayments") && r2658.payments) {
    return json({ customerpayments: r2658.payments, page_context: { has_more_page: false } });
  }
  if (url.pathname.includes("/customerpayments/fx")) {
    const row = r2658.payments?.find((x) => url.pathname.endsWith(`/${String(x.payment_id)}`));
    return json({ payment: { ...row, invoices: [] } });
  }
  if (url.pathname.endsWith("/contacts/zc-dbox")) return json({ contact: { contact_id: "zc-dbox", contact_name: "Design Box", gst_treatment: "overseas", billing_address: { country: "U.S.A" } } });
  if (url.pathname.endsWith("/customerpayments")) {
    return json({
      customerpayments: [
        { payment_id: "p1", payment_number: "8692", date: "2026-10-31", amount: 3823, reference_number: "630466843630", customer_id: "zc-ranz", customer_name: "RANZ INTERNATIONAL LLC" },
      ],
      page_context: { has_more_page: false },
    });
  }
  if (url.pathname.endsWith("/customerpayments/p1")) {
    return json({ payment: { payment_id: "p1", payment_number: "8692", date: "2026-10-31", amount: 3823, reference_number: "630466843630", customer_id: "zc-ranz", customer_name: "RANZ INTERNATIONAL LLC", invoices: [{ invoice_id: "i1", invoice_number: "INV/26-27/1139", amount_applied: 3823 }] } });
  }
  if (url.pathname.endsWith("/invoices/i1")) {
    return json({ invoice: { invoice_id: "i1", invoice_number: "INV/26-27/1139", date: "2026-10-30", total: 3823, line_items: [{ name: "Google Workspace Business Starter", quantity: 1, rate: 3240, item_total: 3240, description: "ranz.ae Subscription Period: 1 Year/s (30/10/2026 - 29/10/2027)" }] } });
  }
  if (url.pathname.endsWith("/contacts/zc-ranz")) {
    return json({ contact: { contact_id: "zc-ranz", contact_name: "RANZ INTERNATIONAL LLC", place_of_contact: "DL", email: "ops@ranz.example", phone: "+971 50 000 0000" } });
  }
  return json({}, 404);
}

const req = (body: unknown) => new NextRequest("http://localhost:3001/api/integrations/zoho-books/bulk-match", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  clearZohoBatchCache();
  st.role = "owner";
  st.conn = { refreshToken: "rt", orgId: "600", orgName: "Org", connectedAt: null };
  st.lines = [
    { id: L1, txn_date: "2026-10-31", credit: 3823, reference: null, description: "UPI-NAVAS K-navas@oksbi-SBIN0000001-630466843630-PAY" },
    { id: L2, txn_date: "2026-10-30", credit: 999, reference: null, description: "IMPS-1-SOMEONE-x" },
  ];
  st.customers = [];
  st.filters = []; st.writes = 0; st.busyOn = null; zohoCalls.length = 0;
  r2658.payments = null;
  st.rivalLines = null; st.rivalOr = []; st.rivalRanges = [];
  st.tables = {}; st.rpcs = []; st.adminRpcs = []; st.gstFiled = []; st.gstFiledError = false;
  vi.stubEnv("ZOHO_BOOKS_CLIENT_ID", "test-id");
  vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "test-secret");
  vi.stubGlobal("fetch", fakeFetch);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const tenantFilters = (table: string) => st.filters.filter(([t, op, k]) => t === table && op === "eq" && k === "tenant_id").map((f) => f[3]);

describe("R-2402 bulk-match route", () => {
  it("first call: the account's unmatched money-in line ids, own tenant only; no Zoho call", async () => {
    const res = await POST(req({ accountId: ACCOUNT }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, ids: [L1, L2], total: 2 });
    expect(tenantFilters("bank_transactions")).toEqual([TENANT]);
    expect(st.filters).toContainEqual(["bank_transactions", "eq", "bank_account_id", ACCOUNT]);
    expect(st.filters).toContainEqual(["bank_transactions", "is", "matched_to_type", null]);
    expect(zohoCalls).toEqual([]);
  });

  it("a page: the match by UTR, a new customer's Zoho contact (email / phone / state), Zoho calls counted, nothing written", async () => {
    const res = await POST(req({ accountId: ACCOUNT, txnIds: [L1, L2] }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].result.kind).toBe("match");
    expect(body.rows[0].result.match).toMatchObject({ by: "utr", payment: { number: "8692" }, invoices: [{ number: "INV/26-27/1139" }] });
    expect(body.rows[0].contact).toMatchObject({ name: "RANZ INTERNATIONAL LLC", stateCode: "07", email: "ops@ranz.example", phone: "+971 50 000 0000" });
    expect(body.rows[1].result.kind).toBe("none");
    expect(body.zohoCalls).toBe(zohoCalls.length);
    expect(zohoCalls.filter((p) => p.endsWith("/customerpayments"))).toHaveLength(1);
    expect(tenantFilters("customers")).toEqual([TENANT]);
    expect(st.writes).toBe(0);
  });

  it("R-2419: an app customer's row carries what the app has — open quotes (the user's own RPC), opening invoices, receipts — every read own tenant", async () => {
    st.customers = [{ id: "c-ranz", name: "RANZ INTERNATIONAL LLC", gstin: null }];
    st.tables = {
      open_items: [{ kind: "renewal", quote_id: "Q-1", invoice_id: null, doc_date: "2026-10-20", amount_due: 3823, taxable_value: 3240, makes_subscription: false },
        /* R-2466: the list now carries opening invoices too — the plan reads them as `openings`, not as open items */
        { kind: "opening", quote_id: null, invoice_id: "OPN-1", doc_date: "2025-05-01", amount_due: 4000, taxable_value: 0, makes_subscription: false }],
      quotes: [{ id: "Q-1", below_cost: true, approval_status: "pending" }],
      invoices: [{ id: "OPN-1", customer_id: "c-ranz", external_number: "INV/25-26/9", invoice_date: "2025-05-01", amount: 5000, net_payable: 5000, paid_amount: 1000 }],
      payments: [{ id: "pay-1", customer_id: "c-ranz", amount: 3823, received_at: "2026-10-15T10:00:00Z", reference: "UTR9" }],
      opening_balances: [{ as_of: "2026-03-31" }],
    };
    const body = await (await POST(req({ accountId: ACCOUNT, txnIds: [L1] }))).json();
    expect(body.rows[0].booksStart).toBe("2026-04-01");
    expect(body.rows[0].facts).toMatchObject({
      customerId: "c-ranz",
      openItems: [{ quoteId: "Q-1", due: 3823, taxable: 3240 }],
      openings: [{ id: "OPN-1", number: "INV/25-26/9", due: 4000 }],
      receipts: [{ id: "pay-1", date: "2026-10-15", amount: 3823, reference: "UTR9" }],
    });
    expect(body.rows[0].facts.openItems).toHaveLength(1);
    expect(body.rows[0].facts.openItems[0].approvalBlock).toMatch(/below cost/);
    expect(st.rpcs).toEqual([["bank_credit_open_items", { p_customer_id: "c-ranz" }]]);
    for (const t of ["invoices", "payments", "subscriptions", "quotes", "opening_balances"]) {
      expect(tenantFilters(t).length).toBeGreaterThan(0);
      expect(new Set(tenantFilters(t))).toEqual(new Set([TENANT])); // R-2621: invoices is read twice (openings + Zoho numbers)
    }
    expect(st.writes).toBe(0);
  });

  it("R-2621: each row carries its GST-filed days (admin gst_filed_days, own tenant) and its Zoho invoices already in the app", async () => {
    st.customers = [{ id: "c-ranz", name: "RANZ INTERNATIONAL LLC", gstin: null }];
    st.gstFiled = ["2026-10-30"];
    st.tables = {
      invoices: [
        { id: "INV/26-27/1139", customer_id: "c-ranz", external_number: "INV/26-27/1139", invoice_date: "2026-10-30", amount: 3823, net_payable: 3823, paid_amount: 0, taxable_value: 3240, status: "pending", document_kind: "tax_invoice" },
        { id: "INV-VOID", customer_id: "c-ranz", external_number: "INV/26-27/1139", invoice_date: "2026-10-30", amount: 3823, net_payable: 3823, paid_amount: 0, taxable_value: 3240, status: "void", document_kind: "tax_invoice" },
      ],
    };
    const body = await (await POST(req({ accountId: ACCOUNT, txnIds: [L1] }))).json();
    expect(st.adminRpcs).toEqual([["gst_filed_days", { p_tenant_id: TENANT, p_days: ["2026-10-30", "2026-10-31"] }]]);
    expect(body.rows[0].gstFiled).toEqual(["2026-10-30"]);
    expect(body.rows[0].zohoSales).toEqual([{ number: "INV/26-27/1139", invoiceId: "INV/26-27/1139", customerId: "c-ranz", date: "2026-10-30", due: 3823, taxable: 3240 }]);
    expect(st.filters).toContainEqual(["invoices", "in", "external_number", ["INV/26-27/1139"]]);
    expect(st.writes).toBe(0);
  });

  it("R-2621: the GST-filed read fails → the page is refused, nothing planned blind", async () => {
    st.gstFiledError = true;
    const res = await POST(req({ accountId: ACCOUNT, txnIds: [L1] }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/months whose GST is already filed/);
  });

  it("the window read is cached — a second page reads no payment list again", async () => {
    await POST(req({ accountId: ACCOUNT, txnIds: [L2] }));
    zohoCalls.length = 0;
    const body = await (await POST(req({ accountId: ACCOUNT, txnIds: [L2] }))).json();
    expect(body.zohoCalls).toBe(0);
  });

  it("tenant scoping: a line not among this tenant's unmatched lines (another company's, or booked meanwhile) is skipped, never planned", async () => {
    const body = await (await POST(req({ accountId: ACCOUNT, txnIds: [OTHER] }))).json();
    expect(body).toMatchObject({ ok: true, rows: [], skipped: [OTHER], zohoCalls: 0 });
  });

  it("Zoho busy part way → the lines done so far + stopped (the page carries on later)", async () => {
    st.busyOn = "/invoices/";
    const body = await (await POST(req({ accountId: ACCOUNT, txnIds: [L1] }))).json();
    expect(body).toMatchObject({ ok: true, rows: [], stopped: { code: "busy" } });
  });

  it("only an owner or accountant", async () => {
    st.role = "sales";
    const res = await POST(req({ accountId: ACCOUNT }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Only an owner or accountant can reconcile from Zoho Books.");
  });

  it("more than a page of lines is refused", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `aaaaaaaa-0000-4000-8000-00000000001${i}`);
    expect((await POST(req({ accountId: ACCOUNT, txnIds: ids }))).status).toBe(400);
  });

  it("not connected → says so, no Zoho call", async () => {
    st.conn = { refreshToken: null, orgId: null, orgName: "Org", connectedAt: null };
    const res = await POST(req({ accountId: ACCOUNT }));
    expect(res.status).toBe(409);
    expect(zohoCalls).toEqual([]);
  });
});

describe("R-2658 bulk-match: a USD inward line paired by its USD amount", () => {
  const usdPay = (id: string, date: string) => ({ payment_id: id, payment_number: id.toUpperCase(), date, amount: 1024, reference_number: "", customer_id: "zc-dbox", customer_name: "Design Box", currency_code: "USD", exchange_rate: 93.1 });
  const inw = (id: string, date: string) => ({ id, txn_date: date, credit: 95846, reference: null, description: "INW 070826I049902623 USD1024.0@93.6" });

  it("one USD payment 6 days before the bank date → by fx_amount; Zoho is asked for ±10 days round the line", async () => {
    st.lines = [inw(L1, "2026-08-07")];
    r2658.payments = [usdPay("fx1", "2026-08-01")];
    const body = await (await POST(req({ accountId: ACCOUNT, txnIds: [L1] }))).json();
    expect(body.rows[0].result).toMatchObject({ kind: "match", match: { by: "fx_amount", payment: { zohoId: "fx1", currency: "USD", amount: 1024 } } });
    expect(st.writes).toBe(0);
  });

  it("two candidates → several, nothing matched", async () => {
    st.lines = [inw(L1, "2026-08-07")];
    r2658.payments = [usdPay("fx1", "2026-08-01"), usdPay("fx2", "2026-08-10")];
    const body = await (await POST(req({ accountId: ACCOUNT, txnIds: [L1] }))).json();
    expect(body.rows[0].result.kind).toBe("several");
  });

  it("another unmatched line of the account with the same USD amount (not on this page) → matched, but not sure", async () => {
    st.lines = [inw(L1, "2026-08-07"), inw(L2, "2026-08-03")];
    r2658.payments = [usdPay("fx1", "2026-08-01")];
    const body = await (await POST(req({ accountId: ACCOUNT, txnIds: [L1] }))).json();
    expect(body.rows[0].result).toMatchObject({ kind: "match", match: { by: "fx_amount", notSure: expect.stringContaining("Another bank line (2026-08-03") } });
  });
  /* The company's other foreign receipts: fillers of another USD amount, ids unlike the account's lines. */
  const filler = (n: number) => ({ id: `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`, txn_date: "2026-08-05", credit: 9310, reference: null, description: "INW 050826I049900000 USD100.0@93.1" });
  const rivalLine = { id: OTHER, txn_date: "2026-08-03", credit: 95334, reference: null, description: "INW 030826I049902000 USD1024.0@93.1" };

  it("the rival read asks only for remittance narrations (not every '@' / UPI handle), paged and ordered", async () => {
    st.lines = [inw(L1, "2026-08-07")];
    r2658.payments = [usdPay("fx1", "2026-08-01")];
    await POST(req({ accountId: ACCOUNT, txnIds: [L1] }));
    expect(st.rivalOr).toHaveLength(1);
    expect(st.rivalOr[0]).toContain("description.ilike.%USD%@%");
    expect(st.rivalOr[0]).toContain("description.ilike.%EUR%@%");
    expect(st.rivalOr[0]).not.toContain("description.ilike.%@%");
    expect(st.rivalRanges[0]).toEqual([0, 999]);
  });

  it("a rival that sits beyond the first 1,000 rows of the company's foreign receipts is still found → not sure", async () => {
    st.lines = [inw(L1, "2026-08-07")];
    st.rivalLines = [...Array.from({ length: 1000 }, (_, n) => filler(n)), rivalLine];
    r2658.payments = [usdPay("fx1", "2026-08-01")];
    const body = await (await POST(req({ accountId: ACCOUNT, txnIds: [L1] }))).json();
    expect(body.rows[0].result).toMatchObject({ kind: "match", match: { by: "fx_amount", notSure: expect.stringContaining("Another bank line (2026-08-03") } });
    expect(st.rivalRanges).toEqual([[0, 999], [1000, 1999]]);
  });

  it("a UPI line with an '@' handle is never a rival, whatever the read returns", async () => {
    st.lines = [inw(L1, "2026-08-07")];
    st.rivalLines = [{ id: OTHER, txn_date: "2026-08-03", credit: 1024, reference: null, description: "UPI-NAVAS K-navas1024@oksbi-SBIN0000001-630466843630-PAY" }];
    r2658.payments = [usdPay("fx1", "2026-08-01")];
    const body = await (await POST(req({ accountId: ACCOUNT, txnIds: [L1] }))).json();
    expect(body.rows[0].result.match.by).toBe("fx_amount");
    expect(body.rows[0].result.match.notSure ?? null).toBeNull();
  });

  it("FAILS CLOSED: the rival read stops at its cap (3,000 rows) → every fx_amount pair is not sure, with the reason", async () => {
    st.lines = [inw(L1, "2026-08-07")];
    st.rivalLines = Array.from({ length: 3000 }, (_, n) => filler(n));
    r2658.payments = [usdPay("fx1", "2026-08-01")];
    const body = await (await POST(req({ accountId: ACCOUNT, txnIds: [L1] }))).json();
    expect(body.rows[0].result).toMatchObject({ kind: "match", match: { by: "fx_amount", notSure: expect.stringContaining("too many bank lines to check") } });
    expect(st.rivalRanges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("FAILS CLOSED: the account's own unmatched lines stop at their cap (3,000) → not sure", async () => {
    st.lines = [inw(L1, "2026-08-07"), ...Array.from({ length: 2999 }, (_, n) => ({ ...filler(n), description: "IMPS-1-SOMEONE-x", credit: 999 }))];
    st.rivalLines = [];
    r2658.payments = [usdPay("fx1", "2026-08-01")];
    const body = await (await POST(req({ accountId: ACCOUNT, txnIds: [L1] }))).json();
    expect(body.rows[0].result).toMatchObject({ kind: "match", match: { by: "fx_amount", notSure: expect.stringContaining("too many bank lines to check") } });
  });
});
