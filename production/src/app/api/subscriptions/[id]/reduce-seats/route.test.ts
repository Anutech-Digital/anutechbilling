/**
 * R-2252 — the Reduce seats route: the server prices the cut (never the browser), refuses what
 * the preview says cannot be saved, and only the seats.change roles may use it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  role: "billing" as string,
  sub: null as Record<string, unknown> | null,
  invoice: null as Record<string, unknown> | null,
  scheduled: null as Record<string, unknown> | null,
  planChangeQuote: null as string | null,
  rpcArgs: null as Record<string, unknown> | null,
  rpcResult: { data: { status: "done" } as unknown, error: null as { code?: string; message: string } | null },
}));

vi.mock("@/lib/dates/ist", () => ({ istToday: () => "2026-11-08" }));
vi.mock("@/lib/subscriptions/apply-seat-increase", () => ({
  resolveSeatTax: async () => ({ taxRatePct: 18, taxLabel: "IGST 18%" }),
}));
vi.mock("./load", () => ({
  REDUCE_SEATS_SELECT: "id",
  loadPartInvoiceMoney: async () => state.invoice,
  loadScheduledReduction: async () => state.scheduled,
  loadOpenPlanChangeQuote: async () => state.planChangeQuote,
}));
vi.mock("@/lib/supabase/server", () => {
  const userClient = {
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { tenant_id: "t-1", role: state.role } }) }) }) }),
  };
  const admin = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.sub }) }) }) }),
    rpc: async (_name: string, args: Record<string, unknown>) => { state.rpcArgs = args; return state.rpcResult; },
  };
  return { createClient: () => userClient, createAdminClientFor: () => admin };
});

import { GET, POST, DELETE } from "./route";

const params = { params: Promise.resolve({ id: "s-1" }) };
const post = (body: unknown) => POST(new Request("http://x/api/subscriptions/s-1/reduce-seats", { method: "POST", body: JSON.stringify(body) }), params);
const PAID = { id: "INV-1", openDue: 0, received: 21240, alreadyCredited: 0, creditable: 21240 };

beforeEach(() => {
  state.role = "billing";
  state.sub = {
    id: "s-1", tenant_id: "t-1", customer_id: "c-1", vendor: "google", seats: 10, mrr: 1500, start_date: "2026-04-01",
    renewal_date: "2027-04-01", status: "active", billing_cycle: "yearly", term_months: 12, quote_id: "Q-1", renewal_quote_id: null,
  };
  state.invoice = PAID;
  state.scheduled = null;
  state.planChangeQuote = null;
  state.rpcArgs = null;
  state.rpcResult = { data: { status: "done" }, error: null };
});

describe("GET preview (R-2252)", () => {
  it("shows the unused value and the credit split for the paid invoice", async () => {
    const res = await GET(new Request("http://x/api/subscriptions/s-1/reduce-seats?seats=2"), params);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.value.subtotal).toBe(1420);
    expect(j.preview.canReduceNow).toBe(true);
    expect(j.preview.split.creditPaise).toBe(j.value.total * 100);
  });
  it("a role without seats.change is refused", async () => {
    state.role = "sales";
    const res = await GET(new Request("http://x/api/subscriptions/s-1/reduce-seats?seats=2"), params);
    expect(res.status).toBe(403);
  });
  it("another company's subscription looks missing", async () => {
    state.sub = { ...state.sub, tenant_id: "t-2" };
    const res = await GET(new Request("http://x/api/subscriptions/s-1/reduce-seats?seats=2"), params);
    expect(res.status).toBe(404);
  });
});

describe("POST (R-2252)", () => {
  it("books NOW with the server's own unused value and new mrr", async () => {
    const res = await post({ seats_removed: 2, timing: "now", idempotency_key: "key-12345678", p_unused_gross: 999999 });
    expect(res.status).toBe(200);
    expect(state.rpcArgs).toMatchObject({ p_seats_removed: 2, p_timing: "now", p_unused_gross: 1676, p_new_mrr: 1200, p_tenant_id: "t-1", p_actor: "u-1", p_seats_before: 10 });
  });
  it("END OF TERM is refused while it is switched off (R-2584: renewal does not apply it yet — R-2583)", async () => {
    const res = await post({ seats_removed: 3, timing: "end_of_term", idempotency_key: "key-12345678" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("end_of_term_off");
    expect(state.rpcArgs).toBeNull();
  });
  it("NOW with no tax invoice for the part is refused before the database", async () => {
    state.invoice = null;
    const res = await post({ seats_removed: 2, timing: "now", idempotency_key: "key-12345678" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("no_invoice");
    expect(state.rpcArgs).toBeNull();
  });
  it("Microsoft NCE after the 7-day window: NOW refused", async () => {
    state.sub = { ...state.sub, vendor: "microsoft" };
    expect((await post({ seats_removed: 2, timing: "now", idempotency_key: "key-12345678" })).status).toBe(409);
    expect(state.rpcArgs).toBeNull();
  });
  it("removing every seat is refused", async () => {
    const res = await post({ seats_removed: 10, timing: "now", idempotency_key: "key-12345678" });
    expect(res.status).toBe(400);
    expect(state.rpcArgs).toBeNull();
  });
  it("a database refusal comes back in its own words; an unknown error does not leak", async () => {
    state.rpcResult = { data: null, error: { code: "23514", message: "A seat cut is already scheduled for the end of this term" } };
    let res = await post({ seats_removed: 2, timing: "now", idempotency_key: "key-12345678" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already scheduled/);
    state.rpcResult = { data: null, error: { code: "XX000", message: "internal relation foo" } };
    res = await post({ seats_removed: 2, timing: "now", idempotency_key: "key-12345678" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toMatch(/foo/);
  });
  it("a written-off subscription gets no credit (NOW refused)", async () => {
    state.sub = { ...state.sub, written_off_at: "2026-10-01T00:00:00Z" };
    const res = await post({ seats_removed: 2, timing: "now", idempotency_key: "key-12345678" });
    expect(res.status).toBe(409);
    expect(state.rpcArgs).toBeNull();
  });
  it("DELETE takes back the scheduled cut", async () => {
    const res = await DELETE(new Request("http://x/api/subscriptions/s-1/reduce-seats", { method: "DELETE" }), params);
    expect(res.status).toBe(200);
    expect(state.rpcArgs).toEqual({ p_tenant_id: "t-1", p_subscription_id: "s-1" });
  });
  it("R-2589: refused while a plan-change quote is open — the message names the quote, nothing booked", async () => {
    state.planChangeQuote = "QT-2026-0042";
    const res = await post({ seats_removed: 3, timing: "now", idempotency_key: "key-12345678" });
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.code).toBe("plan_change_open");
    expect(j.error).toBe("Plan change quote QT-2026-0042 is open for this subscription — it was priced on today's seats. Delete that quote (or record its payment) first, then reduce seats.");
    expect(state.rpcArgs).toBeNull();
  });
  it("R-2589: GET says so before Confirm", async () => {
    state.planChangeQuote = "QT-2026-0042";
    const j = await (await GET(new Request("http://x/api/subscriptions/s-1/reduce-seats?seats=2"), params)).json();
    expect(j.planChangeQuoteId).toBe("QT-2026-0042");
    expect(j.planChangeBlockedReason).toMatch(/^Plan change quote QT-2026-0042 is open/);
  });
  it("R-2589: the database refusal (quote linked after the route checked) keeps the same code", async () => {
    state.rpcResult = { data: null, error: { code: "23514", message: "Plan change quote QT-7 is open for this subscription — it was priced on today's seats. Delete that quote (or record its payment) first, then reduce seats." } };
    const res = await post({ seats_removed: 2, timing: "now", idempotency_key: "key-12345678" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("plan_change_open");
  });
  it("R-2589: no plan-change quote open → the cut goes through as before", async () => {
    state.planChangeQuote = null;
    expect((await post({ seats_removed: 3, timing: "now", idempotency_key: "key-12345678" })).status).toBe(200);
    expect(state.rpcArgs).toMatchObject({ p_seats_removed: 3 });
  });
  it("a body without a key is refused", async () => {
    expect((await post({ seats_removed: 2, timing: "now" })).status).toBe(400);
  });
});
