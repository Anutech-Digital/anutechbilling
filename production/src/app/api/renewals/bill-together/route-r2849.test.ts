/**
 * R-2849 — /api/renewals/bill-together for YEARLY subscriptions: the preview prices each one's next term (one line
 * each, GST on the total), POST makes ONE renewal quote via create_renewal_quote_together through the signed-in client
 * with each part priced by priceRenewalQuote; a retry answers the same quote with nothing priced; a moved renewal date,
 * a refusal, or "not ready" makes nothing. The DB halves are mocked; the pure rules run for real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { TogetherReadFact } from "@/lib/renewals/bill-together.server";
import type { RenewalReadFact } from "@/lib/renewals/bill-together-renewal.server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const st = vi.hoisted(() => ({
  role: "owner" as string,
  facts: [] as unknown[],
  priced: [] as unknown[],
  fillCalls: [] as Array<{ db: string; admin: string; tenantId: string }>,
  rpcCalls: [] as Array<{ client: string; tenantId: string; parts: unknown }>,
  rpc: { data: null as unknown, error: null as null | { code?: string; message: string } },
  ready: { ok: true } as { ok: true } | { ok: false; status: number; error: string },
  readyCalls: 0,
  partsFills: 0,
  laid: 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    __kind: "cookie",
    auth: { getUser: async () => ({ data: { user: { id: USER, email: "o@x.in" } } }) },
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { tenant_id: TENANT, role: st.role } }) };
      return q;
    },
  }),
  createAdminClientFor: (id: string) => { expect(id).toBe(USER); return { __kind: "admin" }; },
}));
vi.mock("@/lib/dates/ist", async (orig) => ({ ...(await orig<object>()), istToday: () => "2026-10-20" }));
vi.mock("@/lib/renewals/bill-together.server", async (orig) => {
  const real = await orig<typeof import("@/lib/renewals/bill-together.server")>();
  return {
    ...real,
    readTogetherFacts: async () => st.facts,
    fillNextParts: async (_db: unknown, f: unknown[]) => { st.partsFills++; return f; },
    layTogetherPart: async () => { st.laid++; return "bill-x"; },
    billPartsTogether: async () => { throw new Error("parts RPC must not be called for yearly subscriptions"); },
  };
});
vi.mock("@/lib/renewals/bill-together-renewal.server", async (orig) => {
  const real = await orig<typeof import("@/lib/renewals/bill-together-renewal.server")>();
  return {
    ...real,
    fillRenewalLines: async (db: { __kind: string }, admin: { __kind: string }, tenantId: string) => {
      st.fillCalls.push({ db: db.__kind, admin: admin.__kind, tenantId });
      return st.priced;
    },
    renewalTogetherReady: async () => { st.readyCalls++; return st.ready; },
    createRenewalQuoteTogether: async (db: { __kind: string }, tenantId: string, parts: unknown) => {
      st.rpcCalls.push({ client: db.__kind, tenantId, parts });
      return st.rpc;
    },
  };
});

import { GET, POST } from "./route";

function read(id: string, o: { renewalQuoteId?: string | null; renewalDate?: string; customer?: string; cycle?: string } = {}): TogetherReadFact {
  const sub = { id, tenant_id: TENANT, customer_id: o.customer ?? "cust-1", customer_name: "ITBUZZ Technologies",
    plan: id === A ? "Business Standard" : "Business Starter", billing_cycle: o.cycle ?? "yearly", status: "active", auto_renew: true,
    renewal_quote_id: o.renewalQuoteId ?? null, seats: id === A ? 20 : 10, mrr: 1800, term_months: 12, term_amount: null,
    start_date: "2025-10-31", renewal_date: o.renewalDate ?? (id === A ? "2026-10-31" : "2026-11-15"), billed_externally_until: null, quote_id: null };
  return { id, sub, row: sub as TogetherReadFact["row"], next: null, togetherBills: [] };
}

function priced(f: TogetherReadFact, o: { linked?: RenewalReadFact["renewal"] extends infer R ? R extends { linked?: infer L } ? L : never : never; start?: string } = {}): RenewalReadFact {
  const std = f.id === A;
  const taxable = std ? 21600 : 16325;
  const start = o.start ?? f.sub!.renewal_date!;
  return {
    ...f,
    renewal: { line: { seats: std ? 20 : 10, seatRate: std ? 1080 : 1632.5, periodStart: start, periodEnd: std ? "2027-10-30" : "2027-11-14",
      taxable, taxRate: 18, tax: Math.round(taxable * 0.18), gross: taxable + Math.round(taxable * 0.18) }, priceError: null, settled: null, linked: o.linked ?? null },
    renewalQuote: { plan: f.sub!.plan, seats: std ? 20 : 10, subtotal: taxable, amount: taxable + Math.round(taxable * 0.18), tax_rate: 18, extension_months: 12, line_items: [] },
  };
}

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/renewals/bill-together${qs}`));
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/renewals/bill-together", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const shown = [{ subscriptionId: A, periodStart: "2026-10-31" }, { subscriptionId: B, periodStart: "2026-11-15" }];

beforeEach(() => {
  st.role = "owner"; st.facts = [read(A), read(B)]; st.priced = (st.facts as TogetherReadFact[]).map((f) => priced(f));
  st.fillCalls = []; st.rpcCalls = []; st.ready = { ok: true }; st.readyCalls = 0; st.partsFills = 0; st.laid = 0;
  st.rpc = { data: { quote_id: "Q-F588-27-0200", created: true, already_existed: false, subscription_ids: [A, B] }, error: null };
});

describe("R-2849 GET yearly", () => {
  it("preview: kind renewal, a line per yearly sub, GST on the total; priced with the admin client after the cookie read", async () => {
    const res = await get(`?ids=${A},${B}`);
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p.kind).toBe("renewal");
    expect(p.subs.map((s: { line: { periodStart: string } }) => s.line.periodStart)).toEqual(["2026-10-31", "2026-11-15"]);
    expect(p.total).toEqual({ taxable: 37925, tax: 6827, gross: 44752 });
    expect(st.fillCalls).toEqual([{ db: "cookie", admin: "admin", tenantId: TENANT }]);
    expect(st.partsFills).toBe(0);
  });

  it("R-2849 not ready: the server's gate is shut → every line says so (nothing to tick)", async () => {
    st.ready = { ok: false, status: 503, error: "One renewal quote for several yearly subscriptions is not ready on this server yet — x" };
    const p = await (await get(`?ids=${A},${B}`)).json();
    expect(p.subs.every((s: { line: unknown; reasons: Array<{ text: string }> }) => !s.line && /not ready on this server/.test(s.reasons[0].text))).toBe(true);
  });

  it("split first → the parts path as before (no renewal pricing)", async () => {
    st.facts = [read(A, { cycle: "monthly" }), read(B)];
    await get(`?ids=${A},${B}`);
    expect(st.fillCalls).toHaveLength(0);
    expect(st.partsFills).toBe(1);
  });
});

describe("R-2849 POST yearly", () => {
  it("R-2849 POST yearly: ONE create_renewal_quote_together through the signed-in client, parts in the asked order with each priced quote → renewal_quote, /quotes/<id>", async () => {
    const res = await post({ ids: [A, B], periods: shown });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quoteId: "Q-F588-27-0200", href: "/quotes/Q-F588-27-0200", alreadyExisted: false,
      subscriptionIds: [A, B], action: "renewal_quote", invoiceId: null });
    expect(st.rpcCalls).toHaveLength(1);
    expect(st.rpcCalls[0].client).toBe("cookie");
    expect(st.rpcCalls[0].tenantId).toBe(TENANT);
    expect((st.rpcCalls[0].parts as Array<{ subscription_id: string; quote: { subtotal: number } }>).map((p) => [p.subscription_id, p.quote.subtotal]))
      .toEqual([[A, 21600], [B, 16325]]);
    expect(st.laid).toBe(0);
  });

  it("R-2849 retry: both already on the same live together quote → that quote (not refused 'already on'), no RPC", async () => {
    st.facts = [read(A, { renewalQuoteId: "Q-T" }), read(B, { renewalQuoteId: "Q-T" })];
    /* fillRenewalLines reads the link (and prices nothing for a sub on a live quote — line null) */
    st.priced = [
      { ...read(A, { renewalQuoteId: "Q-T" }), renewal: { line: null, linked: { quoteId: "Q-T", live: true, subscriptionIds: [A, B], withPlans: ["Business Starter"] } }, renewalQuote: null },
      { ...read(B, { renewalQuoteId: "Q-T" }), renewal: { line: null, linked: { quoteId: "Q-T", live: true, subscriptionIds: [A, B], withPlans: ["Business Standard"] } }, renewalQuote: null },
    ];
    const res = await post({ ids: [A, B], periods: shown });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ quoteId: "Q-T", alreadyExisted: true, action: "renewal_quote", subscriptionIds: [A, B] });
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("R-2849 retry with one more ticked: the together quote holds only two → refused 'already on renewal quote', no RPC", async () => {
    const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    st.facts = [read(A, { renewalQuoteId: "Q-T" }), read(B, { renewalQuoteId: "Q-T" }), read(C)];
    const linked = (plans: string[]) => ({ quoteId: "Q-T", live: true, subscriptionIds: [A, B], withPlans: plans });
    st.priced = [
      { ...read(A, { renewalQuoteId: "Q-T" }), renewal: { line: null, linked: linked(["Business Starter"]) }, renewalQuote: null },
      { ...read(B, { renewalQuoteId: "Q-T" }), renewal: { line: null, linked: linked(["Business Standard"]) }, renewalQuote: null },
      priced(read(C)),
    ];
    const res = await post({ ids: [A, B, C] });
    expect(res.status).toBe(409);
    expect((await res.json()).reasons.map((r: { code: string }) => r.code)).toEqual(["already_together", "already_together"]);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("the RPC answers the same quote (created false) → alreadyExisted true", async () => {
    st.rpc = { data: { quote_id: "Q-T", created: false, already_existed: true, subscription_ids: [A, B] }, error: null };
    expect(await (await post({ ids: [A, B], periods: shown })).json()).toMatchObject({ quoteId: "Q-T", alreadyExisted: true });
  });

  it("R-2849 date moved: a renewal date changed since the dialog → 409 renewal words, no RPC", async () => {
    st.priced = [priced(read(A), { start: "2026-11-30" }), priced(read(B))];
    const res = await post({ ids: [A, B], periods: shown });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/^What will be renewed changed since you opened it — you saw Business Standard's renewal from 31 Oct 2026, now it would renew from 30 Nov 2026/);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("refused in the preview (other customer) → 409 with reasons, no RPC", async () => {
    st.priced = [priced(read(A)), priced(read(B, { customer: "cust-2" }))];
    const res = await post({ ids: [A, B] });
    expect(res.status).toBe(409);
    expect((await res.json()).reasons).toEqual([expect.objectContaining({ subscriptionId: B, code: "other_customer" })]);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("R-2849 not ready: gate shut / RPC missing → 503 plain words, nothing priced, no RPC", async () => {
    st.ready = { ok: false, status: 503, error: "One renewal quote for several yearly subscriptions is not ready on this server yet — x" };
    const res = await post({ ids: [A, B], periods: shown });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not ready on this server/);
    expect(st.fillCalls).toHaveLength(0);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("R-2849 rpc refusal: the RPC's own sentence (22023 / seat cut 23514) → 409; raw DB text → 500 plain", async () => {
    st.rpc = { data: null, error: { code: "22023", message: "Renewal quote Q-1 was already made for Business Starter (due 15 Nov 2026) — cancel it first, then renew together." } };
    let res = await post({ ids: [A, B], periods: shown });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/^Renewal quote Q-1 was already made/);
    st.rpc = { data: null, error: { code: "23514", message: "A seat cut to 15 seats is scheduled for Business Standard on 31 Oct 2026 while its renewal was priced for 20 seats, so no quote was made. Try again — it is priced with the cut." } };
    res = await post({ ids: [A, B], periods: shown });
    expect(res.status).toBe(409);
    st.rpc = { data: null, error: { code: "XX000", message: "duplicate key value violates unique constraint" } };
    res = await post({ ids: [A, B], periods: shown });
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toMatch(/duplicate key/);
  });

  it("a mix (yearly first, a split one ticked) → 409 mixed_billing, no RPC", async () => {
    st.priced = [priced(read(A)), { ...read(B, { cycle: "monthly" }), renewal: null }];
    const res = await post({ ids: [A, B] });
    expect(res.status).toBe(409);
    expect((await res.json()).reasons).toEqual([expect.objectContaining({ subscriptionId: B, code: "mixed_billing" })]);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("sales role → 403 before anything is read", async () => {
    st.role = "sales";
    expect((await post({ ids: [A, B] })).status).toBe(403);
    expect(st.rpcCalls).toHaveLength(0);
  });
});
