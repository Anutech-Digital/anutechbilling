/**
 * R-060 — POST /api/subscriptions/[id]/add-seats must add the seats ONCE.
 *
 * The bug: nothing but `disabled={submitting}` on a button stood between a double
 * click and two seat increases plus two pro-rata quotes for the same expansion.
 *
 * What is pinned here is the ROUTE's half of the fix — that it claims before it works,
 * that a replay returns the first attempt's answer instead of doing the work again, and
 * that a failure which wrote nothing releases the key so the operator can retry. The
 * constraint itself (and the fact that Postgres would refuse the second write even if
 * this code did not) is proved separately in supabase/tests/seat_increase_claims.test.sql.
 *
 * The fake claims table enforces the same unique (tenant_id, idempotency_key) the
 * migration does — a fake that accepted the second insert would let every assertion
 * below pass while the real table was missing its index.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code?: string; message: string } | null };

const state = vi.hoisted(() => ({
  claims: [] as Row[],
  seq: 0,
  sub: null as Row | null,
  apply: null as unknown as (...args: unknown[]) => unknown,
  role: "billing" as string,
  actors: [] as string[], // R-051: who createAdminClientFor() was opened for
}));

vi.mock("@/lib/subscriptions/apply-seat-increase", () => ({
  SEAT_INCREASE_SELECT: "id",
  applySeatIncrease: (...args: unknown[]) => state.apply(...args),
}));

vi.mock("@/lib/supabase/server", () => {
  const makeChain = (table: string) => {
    const ctx: { op: string; payload: Row; filters: Row } =
      { op: "select", payload: {}, filters: {} };

    const run = async (): Promise<Result> => {
      if (table === "subscriptions") {
        return { data: state.sub, error: state.sub ? null : { message: "not found" } };
      }
      if (table === "tenants") return { data: { grace_period_days: 7 }, error: null };
      if (table === "users")   return { data: { tenant_id: "T1", role: state.role }, error: null };
      if (table === "seat_increase_claims") {
        if (ctx.op === "insert") {
          /* The unique index, in five lines. */
          const clash = state.claims.some(
            (c) => c.tenant_id === ctx.payload.tenant_id && c.idempotency_key === ctx.payload.idempotency_key,
          );
          if (clash) return { data: null, error: { code: "23505", message: "duplicate key value" } };
          const row = { id: `claim-${++state.seq}`, ...ctx.payload };
          state.claims.push(row);
          return { data: { id: row.id }, error: null };
        }
        if (ctx.op === "update") {
          const row = state.claims.find((c) => c.id === ctx.filters.id);
          if (row) Object.assign(row, ctx.payload);
          return { data: null, error: null };
        }
        if (ctx.op === "delete") {
          state.claims = state.claims.filter((c) => c.id !== ctx.filters.id);
          return { data: null, error: null };
        }
        const row = state.claims.find(
          (c) => c.tenant_id === ctx.filters.tenant_id && c.idempotency_key === ctx.filters.idempotency_key,
        );
        return { data: row ?? null, error: row ? null : { message: "no rows" } };
      }
      return { data: null, error: null };
    };

    type Chain = {
      select: () => Chain; insert: (p: Row) => Chain; update: (p: Row) => Chain;
      delete: () => Chain; eq: (col: string, val: unknown) => Chain;
      single: () => Promise<Result>; maybeSingle: () => Promise<Result>;
      then: (ok: (r: Result) => unknown, err?: (e: unknown) => unknown) => Promise<unknown>;
    };
    const chain: Chain = {
      select: () => chain,
      insert: (p: Row) => { ctx.op = "insert"; ctx.payload = p; return chain; },
      update: (p: Row) => { ctx.op = "update"; ctx.payload = p; return chain; },
      delete: () => { ctx.op = "delete"; return chain; },
      eq: (col: string, val: unknown) => { ctx.filters[col] = val; return chain; },
      single: () => run(),
      maybeSingle: () => run(),
      then: (ok, err) => run().then(ok, err),
    };
    return chain;
  };

  const client = () => ({
    auth: { getUser: async () => ({ data: { user: { id: "U1" } }, error: null }) },
    from: (table: string) => makeChain(table),
  });
  return {
    createClient: client,
    createAdminClientFor: (actor: string) => { state.actors.push(actor); return client(); },
  };
});

import { POST } from "./route";

const KEY = "intent-0000-1111-2222";
const post = (body: unknown) =>
  POST(
    new Request("https://example.invalid/api/subscriptions/S1/add-seats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "S1" }) },
  );

const okResult = {
  ok: true, quoteId: "Q-ADPL-27-0007", amount: 11836, proRataDays: 200,
  newSeats: 15, newMrr: 9300, poId: "PO-ADPL-27-0003",
};

beforeEach(() => {
  state.claims = [];
  state.seq = 0;
  state.role = "billing";
  state.actors = [];
  state.sub = { id: "S1", tenant_id: "T1", status: "active", renewal_date: "2027-04-01", seats: 10, mrr: 6200 };
  state.apply = vi.fn(async () => okResult);
});

describe("a double POST adds the seats once", () => {
  it("the second request with the same key does no work and returns the first answer", async () => {
    const first  = await post({ additional_seats: 5, idempotency_key: KEY });
    const second = await post({ additional_seats: 5, idempotency_key: KEY });

    /* The assertion the card is about. Everything else here is the shape of the answer;
       this is whether the seats went up twice. */
    expect(state.apply).toHaveBeenCalledTimes(1);

    expect(first.status).toBe(200);
    expect(state.actors[0]).toBe("U1"); // R-051: audit log gets the signed-in caller
    expect(second.status).toBe(200);
    const a = await first.json();
    const b = await second.json();
    expect(b.quoteId).toBe(a.quoteId);
    /* Said out loud, so the dialog can stop claiming "+5 seats added" a second time —
       two success toasts for one expansion moves the confusion into the operator's head. */
    expect(b.replayed).toBe(true);
    expect(a.replayed).toBeUndefined();
  });

  it("a genuinely different intent still goes through", async () => {
    /* The guard has to be narrow. A customer asking for five more seats twice in one
       afternoon is an ordinary thing, and a rule that refused it would be switched off
       within a week (L103). */
    await post({ additional_seats: 5, idempotency_key: KEY });
    const again = await post({ additional_seats: 5, idempotency_key: "intent-3333-4444-5555" });
    expect(again.status).toBe(200);
    expect(state.apply).toHaveBeenCalledTimes(2);
  });

  it("refuses a request with no key at all", async () => {
    const res = await post({ additional_seats: 5 });
    expect(res.status).toBe(400);
    expect(state.apply).not.toHaveBeenCalled();
  });

  it("a request still in flight is told to wait, not run", async () => {
    /* The literal double-click: the replay arrives while the first is mid-write, so
       there is no stored result to hand back yet. */
    state.apply = vi.fn(() => new Promise(() => {}));   // never settles
    void post({ additional_seats: 5, idempotency_key: KEY });
    await new Promise((r) => setTimeout(r, 0));
    const second = await post({ additional_seats: 5, idempotency_key: KEY });
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe("in_progress");
    expect(state.apply).toHaveBeenCalledTimes(1);
  });
});

describe("a failure does not burn the key", () => {
  it("a term that has ended can be retried with the same key once it is renewed", async () => {
    state.apply = vi.fn(async () => ({ ok: false, code: "term_ended", message: "Term has ended — issue a renewal quote instead" }));
    const first = await post({ additional_seats: 5, idempotency_key: KEY });
    expect(first.status).toBe(409);
    /* Nothing was written, so the claim must be gone — otherwise the operator renews the
       subscription, presses the same button and is told it is a duplicate of an add that
       never happened. */
    expect(state.claims).toHaveLength(0);

    state.apply = vi.fn(async () => okResult);
    const retry = await post({ additional_seats: 5, idempotency_key: KEY });
    expect(retry.status).toBe(200);
    expect(state.apply).toHaveBeenCalledTimes(1);
  });

  it("a HALF-written attempt keeps the key and reports itself", async () => {
    /* sub_update_failed means the quote exists and the seats do not. Releasing the key
       here would let a retry raise a SECOND quote on top of the first — the customer
       gets two bills for one expansion, which is the money-shaped version of the bug
       this whole change is about. */
    state.apply = vi.fn(async () => ({ ok: false, code: "sub_update_failed", message: "seats not updated" }));
    const first = await post({ additional_seats: 5, idempotency_key: KEY });
    expect(first.status).toBe(400);
    expect(state.claims).toHaveLength(1);
    expect(state.claims[0].status).toBe("failed");

    state.apply = vi.fn(async () => okResult);
    const retry = await post({ additional_seats: 5, idempotency_key: KEY });
    expect(retry.status).toBe(409);
    expect((await retry.json()).error).toContain("seats not updated");
    expect(state.apply).not.toHaveBeenCalled();
  });
});

describe("who may add seats (S19)", () => {
  it.each(["sales", "support", "delivery"])("%s is refused before anything is claimed", async (role) => {
    state.role = role;
    const res = await post({ additional_seats: 5, idempotency_key: KEY });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/^Only Owner, Manager, Billing/);
    expect(state.apply).not.toHaveBeenCalled();
    expect(state.claims).toHaveLength(0);
  });
});

describe("validation still happens before anything is claimed", () => {
  it("a subscription that is not active burns no key", async () => {
    state.sub = { ...state.sub!, status: "paused" };
    const res = await post({ additional_seats: 5, idempotency_key: KEY });
    expect(res.status).toBe(400);
    /* If the claim were written first, the operator would un-pause the subscription,
       press the same button and be refused as a duplicate. */
    expect(state.claims).toHaveLength(0);
  });
});

describe("R-800 — effective date", () => {
  it("a future effective date is refused with 400 before any claim or work", async () => {
    const res = await post({ additional_seats: 2, idempotency_key: KEY, effective_date: "2999-01-01" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_effective_date");
    expect(state.apply).not.toHaveBeenCalled();
    expect(state.claims).toHaveLength(0);
  });

  it("a date before the term start is refused", async () => {
    state.sub = { ...state.sub, start_date: "2026-04-01" };
    const res = await post({ additional_seats: 2, idempotency_key: KEY, effective_date: "2026-03-31" });
    expect(res.status).toBe(400);
    expect(state.apply).not.toHaveBeenCalled();
  });

  it("a valid backdated date is passed to applySeatIncrease with who chose it, and kept on the claim", async () => {
    state.sub = { ...state.sub, start_date: "2026-04-01" };
    state.apply = vi.fn(async () => ({ ...okResult, effectiveDate: "2026-04-15" }));
    const res = await post({ additional_seats: 2, idempotency_key: KEY, effective_date: "2026-04-15" });
    expect(res.status).toBe(200);
    const args = (state.apply as ReturnType<typeof vi.fn>).mock.calls[0][0] as { effectiveDate: string; effectiveDateSetBy: unknown };
    expect(args.effectiveDate).toBe("2026-04-15");
    expect("effectiveDateSetBy" in args).toBe(true);
    expect((state.claims[0].result as { effectiveDate: string }).effectiveDate).toBe("2026-04-15");
    expect(state.claims[0].requested_by).toBe("U1");
  });
});
