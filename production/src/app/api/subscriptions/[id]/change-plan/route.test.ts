/**
 * R-2227 — POST /api/subscriptions/[id]/change-plan.
 * Pins: role gate (sales refused), another company's sub = 404, preview saves nothing, the draft
 * quote's shape (one line with plan_change, extension_months 0, billing yearly, linked through
 * renewal_quote_id), money comes from the server helper (not the body), and a lost link race
 * deletes the draft and answers 409.
 * R-2617: a scheduled end-of-term seat cut refuses preview AND save (400, nothing saved); cuts not
 * readable → 500 cut_check_failed, nothing saved.
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
  cuts: [] as Row[],
  cutsError: null as { message: string } | null,
  money: { billed: true, openDuePaise: 0, receivedPaise: 3_823_200, alreadyCreditedPaise: 0, invoiced: true },
}));

vi.mock("@/lib/dates/ist", async (orig) => ({
  ...(await orig<typeof import("@/lib/dates/ist")>()),
  istToday: () => "2026-10-01",
}));
vi.mock("@/lib/compliance/gst-registration-server", () => ({ readTenantGstRegistration: async () => null }));
vi.mock("@/lib/subscriptions/change-plan-money.server", () => ({ readPlanChangeMoney: async () => state.money }));

vi.mock("@/lib/supabase/server", () => {
  /* ₹1,080/seat/month = the R-205 Workspace floor for Business Standard (floorWorkspaceRow), so the catalogue price is used as it is. */
  const items = [{
    id: "GW-STD", name: "Google Workspace Business Standard", vendor: "google_workspace", item_type: "subscription",
    msrp: 1080, wholesale: 720, prices: { annual: { msrp: 1080, wholesale: 720 } }, is_active: true,
  }];
  const makeChain = (table: string) => {
    const ctx: { op: string; payload: Row; filters: Row } = { op: "select", payload: {}, filters: {} };
    const run = async (): Promise<Result> => {
      if (table === "users") return { data: { tenant_id: "T1", role: state.role }, error: null };
      if (table === "subscriptions") {
        if (ctx.op === "update") return { data: state.linkRows, error: null };
        const hidden = !state.sub || ("tenant_id" in ctx.filters && ctx.filters.tenant_id !== state.sub.tenant_id);
        return { data: hidden ? null : state.sub, error: null };
      }
      if (table === "subscription_seat_reductions") {
        return state.cutsError ? { data: null, error: state.cutsError } : { data: state.cuts.filter((r) => r.status === ctx.filters.status), error: null };
      }
      if (table === "items") return { data: items.filter((i) => i.id === ctx.filters.id), error: null };
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
    rpc: async () => ({ data: "Q-ANUT-27-0099", error: null }),
  });
  return { createClient: client, createAdminClientFor: () => client() };
});

import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("https://example.invalid/api/subscriptions/S1/change-plan", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: "S1" }) },
  );

beforeEach(() => {
  state.role = "billing";
  state.inserted = [];
  state.deleted = [];
  state.linkRows = [{ id: "S1" }];
  state.cuts = [];
  state.cutsError = null;
  state.money = { billed: true, openDuePaise: 0, receivedPaise: 3_823_200, alreadyCreditedPaise: 0, invoiced: true };
  state.sub = {
    id: "S1", tenant_id: "T1", customer_id: "C1", customer_name: "Acme", plan: "Google Workspace Business Starter",
    item_id: "GW-STR", vendor: "google_workspace", status: "active", seats: 10, mrr: 2700, billing_cycle: "yearly",
    term_months: 12, term_amount: null, start_date: "2026-04-01", renewal_date: "2027-04-01", renewal_quote_id: null,
    quote_id: "Q-0", domain: "acme.in", vendor_cost_per_seat_month: 220, external_source: null, billed_externally_until: null,
  };
});

describe("R-2227 change-plan route", () => {
  it("refuses sales (role gate)", async () => {
    state.role = "sales";
    const res = await post({ to_item_id: "GW-STD", seats: 10 });
    expect(res.status).toBe(403);
    expect(state.inserted).toHaveLength(0);
  });

  it("another company's subscription answers 404", async () => {
    state.sub = { ...state.sub!, tenant_id: "T2" };
    const res = await post({ to_item_id: "GW-STD", seats: 10 });
    expect(res.status).toBe(404);
  });

  it("preview returns the calculation and saves nothing", async () => {
    const res = await post({ to_item_id: "GW-STD", seats: 10, preview: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.calc).toMatchObject({ newCharge: 64620, unused: 16160, credit: 16160, net: 48460 });
    expect(state.inserted).toHaveLength(0);
  });

  it("saves one draft quote linked like an extension of 0 months", async () => {
    const res = await post({ to_item_id: "GW-STD", seats: 10 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ quoteId: "Q-ANUT-27-0099", amountExGst: 48460, amount: 48460 + 8723 });
    const q = state.inserted[0];
    expect(q).toMatchObject({ status: "draft", is_renewal: true, extension_months: 0, billing_cycle: "yearly", subtotal: 48460, seats: 10 });
    const line = (q.line_items as Row[])[0];
    expect(line).toMatchObject({ item_id: "GW-STD", qty: 1, rate: 48460 });
    expect(line.plan_change).toMatchObject({ subscription_id: "S1", seats: 10, new_mrr: 10800, cost_per_seat_month: 720 });
  });

  it("no credit when nothing was paid or is owed on the term (R-2255)", async () => {
    state.money = { billed: true, openDuePaise: 0, receivedPaise: 0, alreadyCreditedPaise: 0, invoiced: true };
    const res = await post({ to_item_id: "GW-STD", seats: 10, preview: true });
    expect((await res.json()).calc).toMatchObject({ credit: 0, net: 64620 });
  });

  it("unknown plan → 400", async () => {
    const res = await post({ to_item_id: "NOPE", seats: 10 });
    expect(res.status).toBe(400);
  });

  it("lost link race → draft deleted, 409", async () => {
    state.linkRows = [];
    const res = await post({ to_item_id: "GW-STD", seats: 10 });
    expect(res.status).toBe(409);
    expect(state.deleted[0]).toMatchObject({ id: "Q-ANUT-27-0099", status: "draft" });
  });

  describe("R-2617 scheduled seat cut", () => {
    const cut = { id: "R1", timing: "end_of_term", status: "scheduled", seats_before: 10, seats_after: 7, effective_date: "2027-04-01" };

    it.each([true, false])("preview=%s: refused 400 with the next step, nothing saved", async (preview) => {
      state.cuts = [cut];
      const res = await post({ to_item_id: "GW-STD", seats: 12, preview });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/A seat cut 10 → 7 is scheduled for the end of this term \(1 Apr 2027\)\. Remove the scheduled seat cut in Manage seats first/);
      expect(state.inserted).toHaveLength(0);
    });

    it("a stale cut from an earlier term (R-2584) does not block", async () => {
      state.cuts = [{ ...cut, effective_date: "2026-04-01" }];
      const res = await post({ to_item_id: "GW-STD", seats: 10, preview: true });
      expect(res.status).toBe(200);
    });

    it("cuts not readable → 500 cut_check_failed, nothing saved", async () => {
      state.cutsError = { message: "boom" };
      const res = await post({ to_item_id: "GW-STD", seats: 10 });
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ code: "cut_check_failed" });
      expect(state.inserted).toHaveLength(0);
    });
  });
});
