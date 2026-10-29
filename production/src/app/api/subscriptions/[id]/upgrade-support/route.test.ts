/**
 * R-2073 — POST /api/subscriptions/[id]/upgrade-support.
 * Pins: the Extend / Add seats role gate (sales refused), the draft quote's shape (one SUP- line,
 * extension_months 0, linked through renewal_quote_id), and that a lost link race removes the
 * draft and answers 409 instead of leaving a quote record_payment cannot find.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };

const state = vi.hoisted(() => ({
  role: "billing" as string,
  sub: null as Row | null,
  inserted: [] as Row[],
  deleted: [] as Row[],
  linkRows: [{ id: "S1" }] as Row[],
}));

vi.mock("@/lib/dates/ist", async (orig) => ({
  ...(await orig<typeof import("@/lib/dates/ist")>()),
  istToday: () => "2027-12-31",
}));
vi.mock("@/lib/compliance/gst-registration-server", () => ({ readTenantGstRegistration: async () => null }));

vi.mock("@/lib/supabase/server", () => {
  const T = "fbb976f1909049f097260901bd144e42";
  const items = [
    { id: `SUP-STANDARD-YR-${T}`,   name: "Anutech Standard Support (Yearly)",   msrp: 0, prices: { annual_total: { msrp: 9_996 } } },
    { id: `SUP-ENTERPRISE-YR-${T}`, name: "Anutech Enterprise Support (Yearly)", msrp: 0, prices: { annual_total: { msrp: 49_992 } } },
  ];
  const makeChain = (table: string) => {
    const ctx: { op: string; payload: Row; filters: Row } = { op: "select", payload: {}, filters: {} };
    const run = async (): Promise<Result> => {
      if (table === "users") return { data: { tenant_id: "T1", role: state.role }, error: null };
      if (table === "subscriptions") {
        if (ctx.op === "update") return { data: state.linkRows, error: null };
        return { data: state.sub, error: state.sub ? null : { message: "not found" } };
      }
      if (table === "items") return { data: items, error: null };
      if (table === "quotes") {
        if (ctx.op === "insert") state.inserted.push(ctx.payload);
        if (ctx.op === "delete") state.deleted.push(ctx.filters);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      select: self, like: self, is: self,
      insert: (p: Row) => { ctx.op = "insert"; ctx.payload = p; return chain; },
      update: (p: Row) => { ctx.op = "update"; ctx.payload = p; return chain; },
      delete: () => { ctx.op = "delete"; return chain; },
      eq: (c: string, v: unknown) => { ctx.filters[c] = v; return chain; },
      single: () => run(), maybeSingle: () => run(),
      then: (ok: (r: Result) => unknown, err?: (e: unknown) => unknown) => run().then(ok, err),
    });
    return chain;
  };
  const client = () => ({
    auth: { getUser: async () => ({ data: { user: { id: "U1" } }, error: null }) },
    from: (t: string) => makeChain(t),
    rpc: async () => ({ data: "Q-ANUT-27-0042", error: null }),
  });
  return { createClient: client, createAdminClientFor: () => client() };
});

import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("https://example.invalid/api/subscriptions/S1/upgrade-support", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: "S1" }) },
  );

beforeEach(() => {
  state.role = "billing";
  state.inserted = [];
  state.deleted = [];
  state.linkRows = [{ id: "S1" }];
  state.sub = {
    id: "S1", tenant_id: "T1", customer_id: "C1", customer_name: "Acme", plan: "Anutech Standard Support (Yearly)",
    item_id: "SUP-STANDARD-YR-fbb976f1909049f097260901bd144e42", status: "active", billing_cycle: "annual",
    term_months: 12, start_date: "2027-07-01", renewal_date: "2028-07-01", renewal_quote_id: null, domain: "acme.in",
  };
});

describe("R-2073 upgrade-support route", () => {
  it("makes one draft quote: ₹19,998 + 18% GST, one SUP- line, extension_months 0", async () => {
    const res = await post({ to_tier: "enterprise" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ quoteId: "Q-ANUT-27-0042", amountExGst: 19_998, amount: 23_598 });
    expect(state.inserted).toHaveLength(1);
    const q = state.inserted[0];
    expect(q).toMatchObject({ status: "draft", subtotal: 19_998, amount: 23_598, tax_rate: 18, is_renewal: true, is_extension: false, extension_months: 0 });
    expect((q.line_items as Row[])[0]).toMatchObject({ item_id: "SUP-ENTERPRISE-YR-fbb976f1909049f097260901bd144e42", qty: 1, rate: 19_998 });
  });

  it("refuses a role that may not change a subscription's terms", async () => {
    state.role = "sales";
    const res = await post({ to_tier: "enterprise" });
    expect(res.status).toBe(403);
    expect(state.inserted).toHaveLength(0);
  });

  it("refuses a downgrade", async () => {
    state.sub = { ...state.sub!, item_id: "SUP-ENTERPRISE-YR-fbb976f1909049f097260901bd144e42" };
    const res = await post({ to_tier: "standard" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Downgrades take effect at renewal");
  });

  it("another quote linked first → the draft is removed and the answer is 409", async () => {
    state.linkRows = [];
    const res = await post({ to_tier: "enterprise" });
    expect(res.status).toBe(409);
    expect(state.deleted).toHaveLength(1);
  });
});
