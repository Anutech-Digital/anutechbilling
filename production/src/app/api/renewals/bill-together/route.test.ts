/**
 * R-2807 — /api/renewals/bill-together on R-2808's contract: the probe (no ids → 400), the preview (never 404 for
 * a bad id), money roles only, tenant from the signed-in profile, POST lays each part then ONE bill_parts_together
 * through the signed-in client, refusals in plain words, and a double submit answers the same proforma.
 * The DB half (readTogetherFacts / layTogetherPart / the RPC call) is mocked; its pure helpers run for real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { TogetherReadFact } from "@/lib/renewals/bill-together.server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const st = vi.hoisted(() => ({
  role: "owner" as string,
  signedIn: true,
  facts: [] as unknown[],
  readCalls: [] as Array<{ client: string; tenantId: string; ids: string[] }>,
  layCalls: [] as Array<{ client: string; tenantId: string; sub: string; periodStart: string }>,
  rpcCalls: [] as Array<{ client: string; ids: string[] }>,
  rpc: { data: null as unknown, error: null as null | { code?: string; message: string } },
  layError: null as Error | null,
  ready: { ok: true } as { ok: true } | { ok: false; status: number; error: string },
  fillCalls: 0,
  invoiced: null as null | { quoteId: string; invoiceId: string; subscriptionIds: string[] },
  invoicedCalls: 0,
  invoicedOpts: null as unknown,
  quoteInvoice: null as string | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    __kind: "cookie",
    auth: { getUser: async () => ({ data: { user: st.signedIn ? { id: USER, email: "o@x.in" } : null } }) },
    from: (t: string) => {
      expect(t).toBe("users");
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { tenant_id: TENANT, role: st.role } }) };
      return q;
    },
  }),
  createAdminClientFor: (id: string) => { expect(id).toBe(USER); return { __kind: "admin" }; },
}));
vi.mock("@/lib/dates/ist", async (orig) => ({ ...(await orig<object>()), istToday: () => "2026-11-14" }));
vi.mock("@/lib/renewals/bill-together.server", async (orig) => {
  const real = await orig<typeof import("@/lib/renewals/bill-together.server")>();
  return {
    ...real,
    readTogetherFacts: async (db: { __kind: string }, tenantId: string, ids: string[]) => {
      st.readCalls.push({ client: db.__kind, tenantId, ids: [...ids] });
      return st.facts;
    },
    layTogetherPart: async (db: { __kind: string }, tenantId: string, row: { id: string }, periodStart: string) => {
      st.layCalls.push({ client: db.__kind, tenantId, sub: row.id, periodStart });
      if (st.layError) throw st.layError;
      return `bill-${row.id.slice(0, 1)}`;
    },
    fillNextParts: async (_db: unknown, facts: unknown[]) => { st.fillCalls++; return facts; },
    billTogetherReady: async () => st.ready,
    findInvoicedTogether: async (db: { __kind: string }, _t: string, _f: unknown, opts: unknown) => {
      expect(db.__kind).toBe("cookie"); st.invoicedCalls++; st.invoicedOpts = opts; return st.invoiced;
    },
    quoteInvoiceId: async (db: { __kind: string }) => { expect(db.__kind).toBe("cookie"); return st.quoteInvoice; },
    billPartsTogether: async (db: { __kind: string }, ids: string[]) => {
      st.rpcCalls.push({ client: db.__kind, ids: [...ids] });
      return st.rpc;
    },
  };
});

import { GET, POST } from "./route";
import { TogetherRefusal, rpcRefusal, virtualTermFor, requestBillingIds } from "@/lib/renewals/bill-together.server";

function fact(id: string, o: { customer?: string; cycle?: string; together?: TogetherReadFact["togetherBills"]; periodStart?: string; taxRate?: number } = {}): TogetherReadFact {
  const sub = { id, tenant_id: TENANT, customer_id: o.customer ?? "cust-1", customer_name: o.customer ? "Other Co" : "ITBUZZ Technologies",
    plan: id === A ? "Business Standard" : "Business Starter", billing_cycle: o.cycle ?? "monthly", status: "active", auto_renew: true,
    renewal_quote_id: null, seats: 10, mrr: 1610, term_months: 12, term_amount: null, start_date: "2025-10-12", renewal_date: "2026-10-11",
    billed_externally_until: null, quote_id: null };
  return {
    id, sub, row: sub as TogetherReadFact["row"], togetherBills: o.together ?? [],
    next: o.cycle === "yearly" ? null : { seats: 10, seatRate: 161, periodStart: o.periodStart ?? "2026-10-12", periodEnd: "2026-11-11",
      taxable: 1610, taxRate: o.taxRate ?? 18, tax: 290, gross: 1900, unpaidEarlier: [] },
  };
}

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/renewals/bill-together${qs}`));
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/renewals/bill-together", {
  method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
}));

beforeEach(() => {
  st.role = "owner"; st.signedIn = true; st.facts = [fact(A), fact(B)];
  st.readCalls = []; st.layCalls = []; st.rpcCalls = []; st.layError = null; st.ready = { ok: true }; st.fillCalls = 0;
  st.invoiced = null; st.invoicedCalls = 0; st.quoteInvoice = null;
  st.rpc = { data: { action: "request", quote_id: "PI-F588-27-0101", already_existed: false, subscription_ids: [A, B] }, error: null };
});

describe("GET /api/renewals/bill-together", () => {
  it("no ids (the screen's probe) → 400 { error }, nothing read", async () => {
    const res = await get("");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Pick the subscriptions/);
    expect(st.readCalls).toHaveLength(0);
  });

  it("not signed in → 401; sales / support → 403 (the probe hides the button)", async () => {
    st.signedIn = false;
    expect((await get(`?ids=${A}`)).status).toBe(401);
    st.signedIn = true;
    for (const role of ["sales", "support"]) {
      st.role = role;
      const res = await get(`?ids=${A},${B}`);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/owner, manager, accountant or billing/);
    }
    for (const role of ["owner", "manager", "accountant", "billing"]) {
      st.role = role;
      expect((await get(`?ids=${A},${B}`)).status).toBe(200);
    }
  });

  it("preview: lines + total; reads with the signed-in client and the profile's company; ids url-decoded, repeats dropped", async () => {
    const res = await get(`?ids=${encodeURIComponent(A)},${encodeURIComponent(B)},${A}`);
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(st.readCalls).toEqual([{ client: "cookie", tenantId: TENANT, ids: [A, B] }]);
    expect(p.subs.map((s: { subscriptionId: string }) => s.subscriptionId)).toEqual([A, B]);
    expect(p.subs[0].line).toEqual({ seats: 10, seatRate: 161, periodStart: "2026-10-12", periodEnd: "2026-11-11", taxable: 1610, taxRate: 18, tax: 290, gross: 1900 });
    expect(p.total).toEqual({ taxable: 3220, tax: 580, gross: 3800 });
    expect(p.currency).toBe("INR");
  });

  it("a bad / other company's id → 200 with reason not_found (never 404)", async () => {
    st.facts = [fact(A), { id: "not-a-uuid", sub: null, next: null, togetherBills: [], row: null }];
    const res = await get(`?ids=${A},not-a-uuid`);
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p.subs[1]).toMatchObject({ subscriptionId: "not-a-uuid", line: null, reasons: [{ code: "not_found" }] });
  });

  it("export / USD customer: currency INR with the 0% GST amounts (the INR proforma's own numbers)", async () => {
    st.facts = [fact(A, { taxRate: 0 }), fact(B, { taxRate: 0 })];
    const p = await (await get(`?ids=${A},${B}`)).json();
    expect(p.currency).toBe("INR");
    expect(p.total).toEqual({ taxable: 3220, tax: 0, gross: 3220 });
  });

  it("too many ids → 400 in plain words", async () => {
    const many = Array.from({ length: 26 }, (_, i) => `id${i}`).join(",");
    const res = await get(`?ids=${many}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most 25/);
  });
});

describe("POST /api/renewals/bill-together", () => {
  it("happy path: lays each part at the PREVIEW's period with the admin client, then ONE RPC call via the signed-in client", async () => {
    const res = await post({ ids: [A, B] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quoteId: "PI-F588-27-0101", href: "/quotes/PI-F588-27-0101", alreadyExisted: false, subscriptionIds: [A, B],
      action: "request", invoiceId: null });
    expect(st.layCalls).toEqual([
      { client: "admin", tenantId: TENANT, sub: A, periodStart: "2026-10-12" },
      { client: "admin", tenantId: TENANT, sub: B, periodStart: "2026-10-12" },
    ]);
    expect(st.rpcCalls).toEqual([{ client: "cookie", ids: ["bill-a", "bill-b"] }]);
  });

  it("the body's tenant is ignored — the profile's company is used", async () => {
    await post({ ids: [A, B], tenantId: "99999999-9999-4999-8999-999999999999" });
    expect(st.readCalls[0].tenantId).toBe(TENANT);
    expect(st.layCalls.every((c) => c.tenantId === TENANT)).toBe(true);
  });

  it("fewer than 2 ids, no body, bad JSON → 400; sales → 403; nothing laid", async () => {
    expect((await post({ ids: [A] })).status).toBe(400);
    expect((await post({ ids: [A, A] })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post("{oops")).status).toBe(400);
    st.role = "sales";
    expect((await post({ ids: [A, B] })).status).toBe(403);
    expect(st.layCalls).toHaveLength(0);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("refusals: other customer / yearly → 409 with each sub's reason, nothing laid, no RPC", async () => {
    st.facts = [fact(A), fact(B, { customer: "cust-2" }), fact("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { cycle: "yearly" })];
    const res = await post({ ids: [A, B, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"] });
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error).toMatch(/2 subscriptions cannot be billed together/);
    expect(j.reasons.map((r: { subscriptionId: string; code: string }) => [r.subscriptionId, r.code])).toEqual([
      [B, "other_customer"], ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "yearly"],
    ]);
    expect(st.layCalls).toHaveLength(0);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("double submit after the first went through: both on the same proforma → same quoteId, alreadyExisted, nothing laid, no RPC", async () => {
    const t = (id: string) => [{ quoteId: "PI-F588-27-0101", status: "sent", withPlans: [id === A ? "Business Starter" : "Business Standard"],
      subscriptionIds: [A, B], partPeriodStart: "2026-10-12", earliestOpen: true }];
    st.facts = [fact(A, { together: t(A), periodStart: "2026-11-12" }), fact(B, { together: t(B) })];
    const res = await post({ ids: [A, B] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quoteId: "PI-F588-27-0101", href: "/quotes/PI-F588-27-0101", alreadyExisted: true, subscriptionIds: [A, B],
      action: "request", invoiceId: null });
    expect(st.fillCalls).toBe(0);   // decided from the cheap read — no previews worked out
    expect(st.layCalls).toHaveLength(0);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("two at once: the RPC (customer advisory lock) answers the existing proforma → alreadyExisted true", async () => {
    st.rpc = { data: { action: "request_open", quote_id: "PI-F588-27-0101", already_existed: true, subscription_ids: [A, B] }, error: null };
    const j = await (await post({ ids: [A, B] })).json();
    expect(j).toMatchObject({ quoteId: "PI-F588-27-0101", alreadyExisted: true });
    expect(st.rpcCalls).toHaveLength(1);
  });

  it("the RPC's refusal is passed on in its own words (22023 → 409, 42501 → 403)", async () => {
    st.rpc = { data: null, error: { code: "22023", message: "The first part of Business Standard is billed by its sale quote Q-1 — bill it from there; later parts can be billed together." } };
    let res = await post({ ids: [A, B] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/billed by its sale quote Q-1/);
    st.rpc = { data: null, error: { code: "42501", message: "These parts are not in your company." } };
    res = await post({ ids: [A, B] });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("These parts are not in your company.");
  });

  it("RPC not deployed yet → 503 BEFORE anything is laid (review F2)", async () => {
    st.ready = { ok: false, status: 503, error: "Bill together is not ready on this server yet — bill each part with Bill next part for now." };
    const res = await post({ ids: [A, B] });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/Bill next part/);
    expect(st.layCalls).toHaveLength(0);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("RPC gone between the check and the call → 503; a raw DB fault → 500 without the raw text", async () => {
    st.rpc = { data: null, error: { code: "PGRST202", message: "Could not find the function public.bill_parts_together" } };
    let res = await post({ ids: [A, B] });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/Bill next part/);
    st.rpc = { data: null, error: { code: "XX000", message: "internal: relation foo" } };
    res = await post({ ids: [A, B] });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/relation foo/);
  });

  it("subscription changed while billing (lay refuses) → 409 in plain words, no RPC", async () => {
    st.layError = new TogetherRefusal(409, "Business Standard changed while billing — reload Renewals and try again.");
    const res = await post({ ids: [A, B] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changed while billing/);
    expect(st.rpcCalls).toHaveLength(0);
  });
});

describe("R-2831 POST: invoice answers, retry after an invoice, login refused before laying", () => {
  it("retry after an 'invoice' answer: the same invoice (action invoice, href /invoices), nothing laid, no previews, no RPC", async () => {
    st.invoiced = { quoteId: "PI-F588-27-0101", invoiceId: "INV-F588-27-0042", subscriptionIds: [A, B] };
    const res = await post({ ids: [A, B] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quoteId: "PI-F588-27-0101", href: "/invoices/INV-F588-27-0042", alreadyExisted: true,
      subscriptionIds: [A, B], action: "invoice", invoiceId: "INV-F588-27-0042" });
    expect(st.fillCalls).toBe(0);
    expect(st.layCalls).toHaveLength(0);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("a live together proforma (double submit) is answered before the invoiced-retry read", async () => {
    const t = (id: string) => [{ quoteId: "PI-1", status: "sent", withPlans: [id === A ? "Business Starter" : "Business Standard"],
      subscriptionIds: [A, B], partPeriodStart: "2026-10-12", earliestOpen: true }];
    st.facts = [fact(A, { together: t(A) }), fact(B, { together: t(B) })];
    expect(await (await post({ ids: [A, B] })).json()).toMatchObject({ quoteId: "PI-1", action: "request" });
    expect(st.invoicedCalls).toBe(0);
  });

  it("the RPC answers 'invoice' (pool paid the started group) → action invoice + invoiceId, href opens the invoice", async () => {
    st.rpc = { data: { action: "invoice", quote_id: "PI-2", already_existed: false, invoice_id: "INV-7", subscription_ids: [A, B] }, error: null };
    expect(await (await post({ ids: [A, B] })).json()).toEqual({ quoteId: "PI-2", href: "/invoices/INV-7", alreadyExisted: false,
      subscriptionIds: [A, B], action: "invoice", invoiceId: "INV-7" });
  });

  it("R-2845: an invoice number with '/' (document series ANU/26-27/…) → href encoded like every invoice link", async () => {
    st.rpc = { data: { action: "invoice", quote_id: "PI-2", already_existed: false, invoice_id: "ANU/26-27/0042", subscription_ids: [A, B] }, error: null };
    expect(await (await post({ ids: [A, B] })).json()).toMatchObject({ href: "/invoices/ANU%2F26-27%2F0042", action: "invoice", invoiceId: "ANU/26-27/0042" });
  });

  it("R-2845: UPPERCASE ids from the screen reach the reads and the period guard lowercase", async () => {
    const res = await post({ ids: [A.toUpperCase(), B], periods: [{ subscriptionId: A.toUpperCase(), periodStart: "2026-10-12" }, { subscriptionId: B, periodStart: "2026-10-12" }] });
    expect(res.status).toBe(200);
    expect(st.readCalls[0].ids).toEqual([A, B]);
    expect(st.invoicedOpts).toEqual({ periods: new Map([[A, "2026-10-12"], [B, "2026-10-12"]]) });
  });

  it("'invoice' with no invoice_id is a fault (500), never a quote link pretending it billed", async () => {
    st.rpc = { data: { action: "invoice", quote_id: "PI-2", already_existed: false, subscription_ids: [A, B] }, error: null };
    expect((await post({ ids: [A, B] })).status).toBe(500);
  });

  it("the RPC's already-existing request that was paid + invoiced since → its invoice; still open → the proforma", async () => {
    st.rpc = { data: { action: "request_open", quote_id: "PI-3", already_existed: true, subscription_ids: [A, B] }, error: null };
    st.quoteInvoice = "INV-9";
    expect(await (await post({ ids: [A, B] })).json()).toMatchObject({ quoteId: "PI-3", href: "/invoices/INV-9", action: "invoice", invoiceId: "INV-9", alreadyExisted: true });
    st.quoteInvoice = null;
    expect(await (await post({ ids: [A, B] })).json()).toMatchObject({ quoteId: "PI-3", href: "/quotes/PI-3", action: "request", invoiceId: null });
  });

  it("the probe says the login may not bill together (42501 / 28000) → 403 / 401 BEFORE anything is laid", async () => {
    st.ready = { ok: false, status: 403, error: "Your login may not bill subscriptions together — ask the workspace owner." };
    let res = await post({ ids: [A, B] });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/may not bill subscriptions together/);
    st.ready = { ok: false, status: 401, error: "You are not signed in — sign in again and try again." };
    res = await post({ ids: [A, B] });
    expect(res.status).toBe(401);
    expect(st.layCalls).toHaveLength(0);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("periods the screen showed: passed to the retry check; same as now → billed", async () => {
    const res = await post({ ids: [A, B], periods: [{ subscriptionId: A, periodStart: "2026-10-12" }, { subscriptionId: B, periodStart: "2026-10-12" }] });
    expect(res.status).toBe(200);
    expect(st.invoicedOpts).toEqual({ periods: new Map([[A, "2026-10-12"], [B, "2026-10-12"]]) });
    expect(st.rpcCalls).toHaveLength(1);
  });

  it("periods moved since the screen showed them (a retry after its parts were billed) → 409 in words, nothing laid, no RPC", async () => {
    st.facts = [fact(A, { periodStart: "2026-11-12" }), fact(B, { periodStart: "2026-11-12" })];
    const res = await post({ ids: [A, B], periods: [{ subscriptionId: A, periodStart: "2026-10-12" }, { subscriptionId: B, periodStart: "2026-10-12" }] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changed since you opened it — you saw Business Standard's part from 12 Oct 2026, now it would bill the part from 12 Nov 2026/);
    expect(st.layCalls).toHaveLength(0);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("malformed periods → 400, nothing read or laid", async () => {
    const res = await post({ ids: [A, B], periods: [{ subscriptionId: A, periodStart: "Oct" }] });
    expect(res.status).toBe(400);
    expect(st.readCalls).toHaveLength(0);
    expect(st.layCalls).toHaveLength(0);
  });

  it("first part of a sale / R-2092 sibling reasons from the preview → 409 before laying", async () => {
    const fa = fact(A); fa.sale = { quoteId: "Q-1", startDate: "2025-10-12", termMonths: 12, firstTermStart: "2025-10-12",
      atNext: { periodIndex: 1, termStart: "2025-10-12" , credited: false }, siblings: [] };
    fa.next = { ...fa.next!, periodStart: "2025-10-12" };
    st.facts = [fa, fact(B)];
    const res = await post({ ids: [A, B] });
    expect(res.status).toBe(409);
    expect((await res.json()).reasons).toEqual([{ subscriptionId: A, code: "first_part_of_sale",
      text: "Its first part is billed by its sale quote Q-1 — bill it from there; later parts can be billed together." }]);
    expect(st.layCalls).toHaveLength(0);
  });
});

describe("R-2807 server helpers (pure)", () => {
  it("virtualTermFor: a part in the next term rolls renewal_date virtually (R-2735 mark); in the current term, none", () => {
    const sub = { billing_cycle: "monthly" as const, term_months: 12, start_date: "2025-10-12", renewal_date: "2026-10-11" };
    expect(virtualTermFor(sub, "2026-09-12")).toEqual({ renewalDate: "2026-10-11", roll: null });
    expect(virtualTermFor(sub, "2026-10-12")).toEqual({ renewalDate: "2027-10-11", roll: { from: "2026-10-11", to: "2027-10-11" } });
  });

  it("requestBillingIds: the lead part and every line's billing_id, once", () => {
    expect(requestBillingIds({ subscription_billing_id: "p1", line_items: [{ billing_id: "p1" }, { billing_id: "p2" }, { name: "x" }] })).toEqual(["p1", "p2"]);
    expect(requestBillingIds({ subscription_billing_id: "p1", line_items: null })).toEqual(["p1"]);
  });

  it("rpcRefusal: Postgres's own wording is never shown (§24); R-2810's guard sentences are", () => {
    expect(rpcRefusal({ code: "42501", message: "permission denied for function bill_parts_together" }))
      .toEqual({ status: 403, error: "Your login may not bill subscriptions together — ask the workspace owner." });
    expect(rpcRefusal({ code: "23505", message: "duplicate key value violates unique constraint" })).toBeNull();
    expect(rpcRefusal({ code: "23505", message: "The part X is already on proforma PI-1 — cancel PI-1 first." })).toEqual({ status: 409, error: "The part X is already on proforma PI-1 — cancel PI-1 first." });
  });
});
