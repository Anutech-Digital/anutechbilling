/**
 * R-2067: the support-sync cron sends queued support-plan changes to DSP.
 * The SQL side (claim / finish, back-off, 5 tries → failed) is in
 * supabase/tests/r2067_support_sync_outbox.test.sql; here: what the route sends and records.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const gate = vi.hoisted(() => ({ run: null as null | { tenants: Set<string>; allTenants: boolean } }));
/* R-897: route logic under test — the automation gate is passed through here; it has its own tests (_lib/automation-gate.test.ts). */
vi.mock("@/lib/automation/cron-gate", () => ({
  gatedCron: (_job: string, h: unknown) => h,
  cronTenantAllowed: (t: string) => !gate.run || gate.run.allTenants || gate.run.tenants.has(t),
  currentCronRun: () => gate.run,
  isCronDryRun: () => false,
  noteWouldSend: () => {},
}));

const db = vi.hoisted(() => ({ rpc: null as null | ReturnType<typeof vi.fn> }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => ({ rpc: db.rpc }) }));

import { GET } from "./route";

const req = () => new Request("https://example.invalid/api/cron/support-sync", { headers: { authorization: "Bearer s3cret" } });
const ENV = { ...process.env };

const PAYLOAD = {
  event_type: "subscription.updated",
  data: { billing_customer_id: "CUST-1", email: "one@example.invalid", plan: "Standard Support (Yearly)", plan_status: "active", plan_expiry: "2027-10-29" },
};
const row = (id: string, tenant = "T1", created = "2026-10-29T00:00:00Z") =>
  ({ id, tenant_id: tenant, customer_id: `C-${id}`, payload: PAYLOAD, attempts: 0, created_at: created });

/** rpc fake: claim returns `rows`; finish returns `finishStatus(args)`. */
function fakeRpc(rows: unknown[], finishStatus: (a: { p_ok: boolean }) => string | null = (a) => (a.p_ok ? "sent" : "pending")) {
  return vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "claim_support_sync_outbox") return { data: rows, error: null };
    if (fn === "finish_support_sync_outbox") return { data: finishStatus(args as { p_ok: boolean }), error: null };
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  process.env.DSP_SUPPORT_URL = "https://dsp.example.invalid/";
  process.env.DSP_WEBHOOK_SECRET = "whsec-test";
  gate.run = null;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  process.env = { ...ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("support-sync cron (R-2067)", () => {
  it("2xx → the row is recorded sent; payload posted unchanged with X-Webhook-Secret", async () => {
    db.rpc = fakeRpc([row("r1")]);
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, claimed: 1, sent: 1, retrying: 0, failed: 0 });
    expect(db.rpc).toHaveBeenCalledWith("claim_support_sync_outbox", { p_limit: 50, p_tenant_ids: null });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dsp.example.invalid/api/sync/customer");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-webhook-secret"]).toBe("whsec-test");
    expect(JSON.parse(String(init.body))).toEqual(PAYLOAD);
    expect(db.rpc).toHaveBeenCalledWith("finish_support_sync_outbox", { p_id: "r1", p_ok: true, p_error: null });
  });

  it("500 → attempts++ via finish (still pending), counted as retrying, not failed", async () => {
    db.rpc = fakeRpc([row("r1")]);
    fetchMock.mockResolvedValue(new Response("Sync failed", { status: 500 }));

    const body = await (await GET(req())).json();

    expect(body).toMatchObject({ claimed: 1, sent: 0, retrying: 1, failed: 0 });
    expect(db.rpc).toHaveBeenCalledWith("finish_support_sync_outbox", { p_id: "r1", p_ok: false, p_error: "HTTP 500: Sync failed" });
  });

  it("the 5th failure → 'failed', counted, and said on stderr for the health digest", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    db.rpc = fakeRpc([row("r1")], () => "failed");
    fetchMock.mockResolvedValue(new Response("down", { status: 503 }));

    const body = await (await GET(req())).json();

    expect(body).toMatchObject({ sent: 0, retrying: 0, failed: 1 });
    expect(err.mock.calls.some((c) => String(c[0]).includes("[cron/support-sync]"))).toBe(true);
  });

  it("a network error / timeout is a failed send, not a crash", async () => {
    db.rpc = fakeRpc([row("r1")]);
    fetchMock.mockRejectedValue(new Error("The operation was aborted due to timeout"));

    const body = await (await GET(req())).json();

    expect(body).toMatchObject({ sent: 0, retrying: 1 });
    expect(db.rpc).toHaveBeenCalledWith("finish_support_sync_outbox",
      { p_id: "r1", p_ok: false, p_error: "The operation was aborted due to timeout" });
  });

  it("no DSP env → no-op: nothing claimed, nothing sent, one log line", async () => {
    delete process.env.DSP_SUPPORT_URL;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.rpc = fakeRpc([row("r1")]);

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, skipped: "not_configured", claimed: 0 });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("no webhook secret → no-op too", async () => {
    delete process.env.DSP_WEBHOOK_SECRET;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    db.rpc = fakeRpc([row("r1")]);
    expect(await (await GET(req())).json()).toMatchObject({ skipped: "not_configured" });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("claims only for the companies the automation switch allows", async () => {
    gate.run = { tenants: new Set(["T1"]), allTenants: false };
    db.rpc = fakeRpc([row("r1", "T1"), row("r2", "T2")]);
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    const body = await (await GET(req())).json();

    expect(db.rpc).toHaveBeenCalledWith("claim_support_sync_outbox", { p_limit: 50, p_tenant_ids: ["T1"] });
    expect(body).toMatchObject({ claimed: 1, sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the claim failing is a 5xx, nothing sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.rpc = vi.fn(async () => ({ data: null, error: { message: "permission denied" } }));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
