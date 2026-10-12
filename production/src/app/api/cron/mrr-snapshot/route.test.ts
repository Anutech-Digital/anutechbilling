/**
 * WC-scale: the MRR snapshot must count EVERY active subscription, not the first 1000.
 *
 * The fake client (lib/ops/fake-postgrest.testutil.ts) cuts every read at 1000 rows, the way
 * PostgREST's max_rows does. Before the fix the cron read subscriptions with one select, so
 * with 2,500 of them the month's snapshot silently held 1,000.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
/* R-897: route logic under test — the automation gate is passed through here; it has its own tests (_lib/automation-gate.test.ts). */
vi.mock("@/lib/automation/cron-gate", () => ({
  gatedCron: (_job: string, h: unknown) => h,
  cronTenantAllowed: () => true,
  isCronDryRun: () => false,
  noteWouldSend: () => {},
}));
import { fakePostgrest } from "@/lib/ops/fake-postgrest.testutil";

const db = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import("@/lib/ops/fake-postgrest.testutil").fakePostgrest> }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => db.current!.client }));

import { GET } from "./route";

const req = (qs = "") => new Request(`https://example.invalid/api/cron/mrr-snapshot${qs}`, { headers: { authorization: "Bearer s3cret" } });
const ENV = { ...process.env };

function subs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    tenant_id: i % 2 === 0 ? "T1" : "T2",
    customer_id: `C${i}`,
    mrr: 100,
    status: "active",
  }));
}

beforeEach(() => { process.env.CRON_SECRET = "s3cret"; });
afterEach(() => { process.env = { ...ENV }; });

describe("mrr-snapshot at scale", () => {
  it("dry run counts all 2,500 active subscriptions (not the capped 1,000)", async () => {
    db.current = fakePostgrest({ subscriptions: [...subs(2500), { id: "x", tenant_id: "T1", customer_id: "CX", mrr: 5, status: "cancelled" }] });
    const body = await (await GET(req("?dry=1"))).json();
    expect(body.customers).toBe(2500);
    expect(body.total_mrr).toBe(250_000);
    const reads = db.current.calls.filter((c) => c.table === "subscriptions");
    expect(reads.length).toBe(3);                       // 0-999, 1000-1999, 2000-2999
    expect(reads.every((c) => c.range !== null)).toBe(true);
  });

  it("live run upserts every customer, in chunks of at most 500", async () => {
    db.current = fakePostgrest({ subscriptions: subs(1234), mrr_snapshots: [] });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const ups = db.current.calls.filter((c) => c.op === "upsert");
    expect(ups.map((c) => (c.payload as unknown[]).length)).toEqual([500, 500, 234]);
    expect(db.current.tables.mrr_snapshots).toHaveLength(1234);
  });

  it("a failed page is a 500, not a short snapshot", async () => {
    db.current = fakePostgrest({ subscriptions: subs(10) });
    const client = db.current.client;
    db.current.client = {
      from: (t: string) => {
        const b = client.from(t) as unknown as Record<string, unknown>;
        b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "statement timeout" } }).then(ok);
        return b as never;
      },
    };
    const res = await GET(req("?dry=1"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/statement timeout/);
  });
});
