/**
 * R-1104 — POST /api/automation/jobs/run: Run now / Retry, owner or manager only, through the
 * job's own cron route with the secret added on the server, for the caller's company only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  role: "owner" as string,
  latest: null as unknown,
  run: null as unknown,
  seen: [] as unknown[],
  cronStatus: 200,
  cronBody: { emails_sent: 1 } as Record<string, unknown>,
}));

vi.mock("@/lib/supabase/server", () => {
  const chain = () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) q[m] = () => q;
    q.single = async () => ({ data: { tenant_id: T, role: h.role }, error: null });
    q.maybeSingle = q.single;
    return q;
  };
  return {
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: ME, email: "me@example.invalid" } } }) },
      from: chain,
    }),
  };
});
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock("@/lib/automation/gate.server", () => ({
  readLatestRun: vi.fn(async () => h.latest),
  readRun: vi.fn(async () => h.run),
}));
vi.mock("@/lib/automation/cron-handlers.server", async () => {
  const { currentManualRun } = await import("@/lib/automation/manual-run");
  return {
    loadCronGet: vi.fn(async () => async (req: Request) => {
      h.seen.push({ manual: currentManualRun(), auth: req.headers.get("authorization"), url: req.url });
      return new Response(JSON.stringify(h.cronBody), { status: h.cronStatus });
    }),
  };
});

import { POST } from "./route";

const call = (body: unknown) =>
  POST(new NextRequest("https://example.invalid/api/automation/jobs/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

const failed = { id: RUN, job: "renewals", ranAt: "2026-10-23T03:30:00Z", status: "failed", trigger: "schedule", result: "Failed (500)", startedBy: null, retryOf: null };

beforeEach(() => {
  process.env.CRON_SECRET = "server-only-secret";
  delete process.env.BUY_PAGE_TENANT_ID;
  h.role = "owner";
  h.latest = null;
  h.run = null;
  h.seen = [];
  h.cronStatus = 200;
  h.cronBody = { emails_sent: 1 };
});

describe("Run now", () => {
  it.each(["owner", "manager"])("%s runs the job through its cron route, for their company, as a manual run", async (role) => {
    h.role = role;
    const res = await call({ job: "renewals" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, job: "renewals", outcome: "ran" });
    expect(h.seen).toEqual([{
      manual: { tenantId: T, userId: ME, trigger: "manual", retryOf: null },
      auth: "Bearer server-only-secret",
      url: "https://example.invalid/api/cron/renewals",
    }]);
  });

  it.each(["sales", "accountant", "billing", "support"])("%s is refused and nothing runs", async (role) => {
    h.role = role;
    const res = await call({ job: "renewals" });
    expect(res.status).toBe(403);
    expect(h.seen).toEqual([]);
  });

  it("a job that is off says so (outcome off)", async () => {
    h.cronBody = { ok: true, skipped: "off", job: "renewals" };
    expect(await (await call({ job: "renewals" })).json()).toMatchObject({ outcome: "off" });
  });

  it("a failing job answers outcome failed", async () => {
    h.cronStatus = 500;
    h.cronBody = { error: "boom" };
    expect(await (await call({ job: "renewals" })).json()).toMatchObject({ outcome: "failed" });
  });

  it("a platform job from an ordinary company is refused", async () => {
    const res = await call({ job: "backup" });
    expect(res.status).toBe(403);
    expect(h.seen).toEqual([]);
  });

  it("no cron secret on the server → 503, nothing runs", async () => {
    delete process.env.CRON_SECRET;
    expect((await call({ job: "renewals" })).status).toBe(503);
    expect(h.seen).toEqual([]);
  });

  it("a second press within a minute of a manual start is refused", async () => {
    h.latest = { ...failed, status: "ok", trigger: "manual", ranAt: new Date(Date.now() - 20_000).toISOString() };
    const res = await call({ job: "renewals" });
    expect(res.status).toBe(409);
    expect(h.seen).toEqual([]);
  });

  it("an unknown job is a 400", async () => {
    expect((await call({ job: "not-a-job" })).status).toBe(400);
  });
});

describe("Retry", () => {
  it("retries the newest failed run, marked as a retry of it", async () => {
    h.latest = failed;
    h.run = failed;
    const res = await call({ job: "renewals", retryOf: RUN });
    expect(res.status).toBe(200);
    expect((h.seen[0] as { manual: unknown }).manual).toEqual({ tenantId: T, userId: ME, trigger: "retry", retryOf: RUN });
  });

  it("a failed run that is no longer the newest cannot be retried", async () => {
    h.run = failed;
    h.latest = { ...failed, id: "33333333-3333-4333-8333-333333333333", status: "ok" };
    const res = await call({ job: "renewals", retryOf: RUN });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/newer run/);
    expect(h.seen).toEqual([]);
  });

  it("a run that did not fail cannot be retried", async () => {
    h.run = { ...failed, status: "ok" };
    h.latest = h.run;
    expect((await call({ job: "renewals", retryOf: RUN })).status).toBe(409);
  });

  it("another company's run (not found under this company) is a 404", async () => {
    h.run = null;
    expect((await call({ job: "renewals", retryOf: RUN })).status).toBe(404);
  });
});
