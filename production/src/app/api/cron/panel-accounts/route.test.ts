/**
 * R-2103: the panel-accounts cron sends DMS customer.ensure for every queued paying customer.
 * The SQL side (trigger on payments, claim / finish, needs_email, backfill) is in
 * supabase/tests/r2103_panel_account_outbox.test.sql; here: what the route sends and records.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const gate = vi.hoisted(() => ({ run: null as null | { tenants: Set<string>; allTenants: boolean } }));
vi.mock("@/lib/automation/cron-gate", () => ({
  gatedCron: (_job: string, h: unknown) => h,
  cronTenantAllowed: (t: string) => !gate.run || gate.run.allTenants || gate.run.tenants.has(t),
  currentCronRun: () => gate.run,
  isCronDryRun: () => false,
  noteWouldSend: () => {},
}));

const engine = vi.hoisted(() => ({ configured: true, send: null as null | ReturnType<typeof vi.fn> }));
vi.mock("@/lib/dms-engine/commands", () => ({
  commandsConfigured: () => engine.configured,
  sendEngineCommand: (...a: unknown[]) => engine.send!(...a),
}));
vi.mock("@/lib/automation/gate.server", () => ({ automationState: async () => "on" }));

const db = vi.hoisted(() => ({ rpc: null as null | ReturnType<typeof vi.fn> }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => ({ rpc: db.rpc }) }));

import { GET } from "./route";

const req = () => new Request("https://example.invalid/api/cron/panel-accounts", { headers: { authorization: "Bearer s3cret" } });
const ENV = { ...process.env };

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, tenant_id: "T1", customer_id: `cust-${id}`, attempts: 0,
  email: "asha@example.invalid", customer_name: "Asha Traders", contact_name: "Asha Verma",
  contact_first_name: null, contact_last_name: null, phone: "+91 98765 43210", gstin: null,
  state: null, address: null, city: null, pin_code: null, country: "India", customer_number: "C-00007",
  ...over,
});

function fakeRpc(rows: unknown[]) {
  return vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "claim_panel_account_outbox") return { data: rows, error: null };
    if (fn === "finish_panel_account_outbox") {
      const r = args.p_result as string;
      return { data: r === "done" ? "done" : r === "needs_email" ? "needs_email" : "pending", error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  });
}
const finishCalls = () =>
  db.rpc!.mock.calls.filter((c) => c[0] === "finish_panel_account_outbox").map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  process.env.PANEL_ACCOUNTS_LIVE = "1";
  engine.configured = true;
  engine.send = vi.fn(async () => ({ kind: "done", result: { userId: "u-1", created: true }, replayed: false }));
  gate.run = null;
});
afterEach(() => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
});

describe("panel-accounts cron (R-2103)", () => {
  it("sends customer.ensure for the claimed customer and records done with the DMS user", async () => {
    db.rpc = fakeRpc([row("r1")]);
    const res = await GET(req());
    const body = await res.json();

    expect(body).toMatchObject({ ok: true, claimed: 1, done: 1, retrying: 0 });
    expect(db.rpc).toHaveBeenCalledWith("claim_panel_account_outbox", { p_limit: 50, p_tenant_ids: null, p_customer_id: null });
    const cmd = engine.send!.mock.calls[0][0];
    expect(cmd).toMatchObject({ command: "customer.ensure", subject: "asha@example.invalid", mode: "live" });
    expect(cmd.commandId).toMatch(/^rsos-acct-cust-r1-\d{8}$/);
    expect(cmd.payload.customer).toMatchObject({
      firstName: "Asha", lastName: "Verma", email: "asha@example.invalid", phone: "9876543210", phoneCc: "91",
      companyName: "Asha Traders", billingCustomerId: "C-00007",
    });
    expect(finishCalls()[0]).toEqual({ p_id: "r1", p_result: "done", p_dms_user_id: "u-1", p_error: null });
  });

  it("DMS gate closed → wait (no attempt used); unreachable → retry", async () => {
    db.rpc = fakeRpc([row("r1"), row("r2")]);
    engine.send = vi.fn()
      .mockResolvedValueOnce({ kind: "gate_closed", reason: "ENGINE_CUSTOMER_ACCOUNT_LIVE is off" })
      .mockResolvedValueOnce({ kind: "unreachable", reason: "ECONNREFUSED" });
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ claimed: 2, done: 0, waiting: 1, retrying: 1 });
    expect(finishCalls().map((a) => a.p_result).sort()).toEqual(["retry", "wait"]);
  });

  it("a row with no valid email is never sent — recorded needs_email", async () => {
    db.rpc = fakeRpc([row("r1", { email: "not-an-email" })]);
    const body = await (await GET(req())).json();
    expect(engine.send).not.toHaveBeenCalled();
    expect(body).toMatchObject({ needsEmail: 1 });
    expect(finishCalls()[0]).toMatchObject({ p_result: "needs_email" });
  });

  it("PANEL_ACCOUNTS_LIVE not exactly 1 → nothing claimed or sent", async () => {
    process.env.PANEL_ACCOUNTS_LIVE = "true";
    db.rpc = fakeRpc([row("r1")]);
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ ok: true, skipped: "not_configured", claimed: 0 });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(engine.send).not.toHaveBeenCalled();
  });

  it("no DMS command key → nothing claimed or sent", async () => {
    engine.configured = false;
    db.rpc = fakeRpc([row("r1")]);
    const body = await (await GET(req())).json();
    expect(body.skipped).toBe("not_configured");
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("no cron bearer → 401, nothing claimed", async () => {
    db.rpc = fakeRpc([row("r1")]);
    const res = await GET(new Request("https://example.invalid/api/cron/panel-accounts"));
    expect(res.status).toBe(401);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("claims only for the companies the switch is on for, and skips rows of others", async () => {
    gate.run = { tenants: new Set(["T1"]), allTenants: false };
    db.rpc = fakeRpc([row("r1"), row("r2", { tenant_id: "T2" })]);
    const body = await (await GET(req())).json();
    expect(db.rpc).toHaveBeenCalledWith("claim_panel_account_outbox", { p_limit: 50, p_tenant_ids: ["T1"], p_customer_id: null });
    expect(body.claimed).toBe(1);
    expect(engine.send).toHaveBeenCalledTimes(1);
  });
});
