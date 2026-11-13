/**
 * R-2726 — GET /api/admin/feedback/platform with search / filters / sort / paging.
 *
 * The access rule is the one this route always had, and the new parameters must not bend it:
 *  - not signed in → 401, not the platform owner → 403, both BEFORE the service role exists
 *    and before any parameter is read — the answer is byte-for-byte the same whatever the
 *    query string says, so search or a workspace filter cannot be used to probe other tenants;
 *  - "scope" is not a parameter: there is nothing a caller can send to become the platform;
 *  - for the platform owner the filters reach BOTH reads (the page and the tab counts).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Call = [string, ...unknown[]];
interface Query { table: string; cols: string; calls: Call[] }

const db = vi.hoisted(() => ({
  email: "owner@platform.test" as string | null,
  adminCreated: 0,
  queries: [] as Array<{ table: string; cols: string; calls: Array<[string, ...unknown[]]> }>,
  feedback: [] as Array<Record<string, unknown>>,
  tenants: [] as Array<{ id: string; name: string }>,
}));

vi.mock("@/lib/platform", () => ({ isPlatformAdmin: (e: string | null | undefined) => e === "owner@platform.test" }));

function adminFrom(table: string) {
  const rec: Query = { table, cols: "", calls: [] };
  db.queries.push(rec);
  const rows = () => {
    if (table === "users") return [{ tenant_id: "tenant-own" }];
    if (table === "tenants") return db.tenants;
    if (table === "feedback_screenshots") return [];
    /* Only what the assertions need: an eq on tenant_id / status really filters. */
    let out = db.feedback;
    for (const [op, col, v] of rec.calls) if (op === "eq") out = out.filter((r) => r[col as string] === v);
    const range = rec.calls.find(([op]) => op === "range");
    return range ? out.slice(range[1] as number, (range[2] as number) + 1) : out;
  };
  const q: Record<string, unknown> = {
    select(cols: string) { rec.cols = cols; return q; },
    single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    then: (ok: (v: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok),
  };
  for (const m of ["eq", "gte", "gt", "lt", "is", "not", "or", "order", "range", "in", "limit"]) {
    q[m] = (...args: unknown[]) => { rec.calls.push([m, ...args]); return q; };
  }
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: db.email === null ? null : { id: "caller-1", email: db.email } } }) },
  }),
  createAdminClient: () => {
    db.adminCreated++;
    return { from: adminFrom, storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed.invalid/x" } }) }) } };
  },
}));

import { GET } from "./route";

const OTHER = "11111111-1111-4111-8111-111111111111";
const call = (qs = "") => GET(new Request(`https://example.invalid/api/admin/feedback/platform${qs}`));
const feedbackQueries = () => db.queries.filter((q) => q.table === "feedback");
const has = (q: Query, op: string, ...args: unknown[]) =>
  q.calls.some((c) => c[0] === op && args.every((a, i) => JSON.stringify(c[i + 1]) === JSON.stringify(a)));

const row = (over: Record<string, unknown>) => ({
  id: "r1", tenant_id: "tenant-own", status: "open", agent_claimed_at: null, dispatched_at: null,
  reporter_name: "Pardeep", reporter_email: "pardeep@anutech.in", route_pattern: "/tasks", page_path: "/tasks",
  title: "t", body: "b", created_at: "2026-11-12T05:00:00Z", ...over,
});

beforeEach(() => {
  db.email = "owner@platform.test";
  db.adminCreated = 0;
  db.queries = [];
  db.tenants = [{ id: "tenant-own", name: "Anutech" }, { id: OTHER, name: "Excel" }];
  db.feedback = [
    row({ id: "r1" }),
    row({ id: "r2", tenant_id: OTHER, reporter_name: "Hitesh", reporter_email: "hitesh@excel.invalid", title: "Scorecards total is wrong", route_pattern: "/reports/scorecards" }),
    row({ id: "r3", tenant_id: OTHER, status: "agent_queued", agent_claimed_at: "2026-11-12T06:00:00Z", dispatched_at: "2026-11-12T05:30:00Z" }),
  ];
});

describe("who may call it — unchanged, and blind to the parameters", () => {
  const PROBES = ["", `?ws=${OTHER}`, "?q=scorecard", `?ws=${OTHER}&q=hitesh&status=open&facets=1`, "?scope=all&admin=1&tenant_id=" + OTHER];

  it("not signed in → 401 for every query string; the service role is never created", async () => {
    db.email = null;
    const bodies = new Set<string>();
    for (const qs of PROBES) {
      const res = await call(qs);
      expect(res.status).toBe(401);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    expect(db.adminCreated).toBe(0);
    expect(db.queries.length).toBe(0);
  });

  it("a tenant user → the same 403 for every query string (no filter / search oracle)", async () => {
    db.email = "owner@some-tenant.test";
    const bodies = new Set<string>();
    for (const qs of PROBES) {
      const res = await call(qs);
      expect(res.status).toBe(403);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    const only = JSON.parse([...bodies][0]) as Record<string, unknown>;
    expect(Object.keys(only).sort()).toEqual(["error", "nextStep"]);
    expect(db.adminCreated).toBe(0);
    expect(db.queries.length).toBe(0);
  });
});

describe("platform owner — filters, sort and paging happen in the query", () => {
  it("no parameters: every workspace, newest first, first 50, with tab counts", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(3);
    expect(json.page).toBe(1);
    expect(json.pageSize).toBe(50);
    expect(json.counts).toEqual({ all: 3, open: 2, queued: 0, ai_working: 1, fixed: 0, wont_fix: 0, duplicate: 0 });
    expect(json.rows.map((r: { id: string }) => r.id)).toEqual(["r1", "r2", "r3"]);
    expect(json.rows[1].tenantName).toBe("Excel");
    expect(json.rows[1].isOwnWorkspace).toBe(false);
    expect(json.rows[0].isOwnWorkspace).toBe(true);

    const page = feedbackQueries().find((q) => q.cols === "*")!;
    expect(has(page, "order", "created_at", { ascending: false })).toBe(true);
    expect(has(page, "range", 0, 49)).toBe(true);
    expect(page.calls.some((c) => c[0] === "eq" && c[1] === "tenant_id")).toBe(false);
  });

  it("ws + search + status reach the page read; the count read gets all but the status", async () => {
    const res = await call(`?ws=${OTHER}&q=scorecard&status=open&sort=oldest&p=2`);
    const json = await res.json();
    expect(json.page).toBe(2);
    const page = feedbackQueries().find((q) => q.cols === "*")!;
    const counts = feedbackQueries().find((q) => q.cols.includes("agent_claimed_at") && !q.cols.includes("reporter_email"))!;
    for (const q of [page, counts]) {
      expect(has(q, "eq", "tenant_id", OTHER)).toBe(true);
      expect(q.calls.some((c) => c[0] === "or" && String(c[1]).includes('title.ilike."%scorecard%"'))).toBe(true);
    }
    expect(has(page, "eq", "status", "open")).toBe(true);
    expect(has(counts, "eq", "status", "open")).toBe(false);
    expect(has(page, "order", "created_at", { ascending: true })).toBe(true);
    expect(has(page, "range", 50, 99)).toBe(true);
    /* counts are for the filters without the status: both of Excel's rows. */
    expect(json.counts.all).toBe(2);
    expect(json.total).toBe(1);
  });

  it("'new since' is taken only as an ISO time", async () => {
    await call("?new=1&since=2026-11-12T04:00:00.000Z");
    expect(has(feedbackQueries().find((q) => q.cols === "*")!, "gt", "created_at", "2026-11-12T04:00:00.000Z")).toBe(true);
    db.queries = [];
    await call("?new=1&since=now()");
    expect(feedbackQueries().find((q) => q.cols === "*")!.calls.some((c) => c[0] === "gt")).toBe(false);
  });

  it("malformed values are ignored, never passed on", async () => {
    await call("?ws=not-a-uuid&status=deleted&sort=tenant_id&p=abc");
    const page = feedbackQueries().find((q) => q.cols === "*")!;
    expect(page.calls.filter((c) => c[0] === "eq")).toEqual([]);
    expect(has(page, "range", 0, 49)).toBe(true);
  });

  it("?facets=1 → the picker choices and how many open reports can go to the AI", async () => {
    const res = await call("?facets=1&q=ignored");
    const json = await res.json();
    expect(json.rows).toBeUndefined();
    expect(json.facets.workspaces).toEqual([
      { value: OTHER, label: "Excel", count: 2 },
      { value: "tenant-own", label: "Anutech", count: 1 },
    ]);
    expect(json.facets.reporters.map((r: { value: string }) => r.value)).toEqual(["pardeep@anutech.in", "hitesh@excel.invalid"]);
    expect(json.openToSend).toBe(2);
  });
});
