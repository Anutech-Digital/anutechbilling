/**
 * R-2142 (GP-D3): a personal account erase turns the customer's DMS panel login off.
 * panel_account_outbox gains op 'deactivate'; the same claim → send → finish path sends DMS
 * `customer.deactivate` for those rows. SQL side: supabase/tests/gpd3_panel_outbox_deactivate.test.sql.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const engine = vi.hoisted(() => ({ send: null as null | ReturnType<typeof vi.fn> }));
vi.mock("@/lib/dms-engine/commands", () => ({
  commandsConfigured: () => true,
  sendEngineCommand: (...a: unknown[]) => engine.send!(...a),
}));
vi.mock("@/lib/automation/gate.server", () => ({ automationState: async () => "on" }));

import {
  buildDeactivateCommand,
  emptyProcessResult,
  panelDeactivateCommandId,
  processPanelAccountRow,
  queuePanelAccountDeactivate,
  type PanelAccountRow,
} from "./panel-account.server";

const ROW: PanelAccountRow = {
  id: "o1", tenant_id: "T1", customer_id: "cust-1", attempts: 0, op: "deactivate", email: " Asha@Example.invalid ",
  customer_name: "Asha", contact_name: null, contact_first_name: null, contact_last_name: null,
  phone: null, gstin: null, state: null, address: null, city: null, pin_code: null, country: null, customer_number: "C-00007",
};

function fakeDb(over: Record<string, unknown> = {}) {
  return {
    rpc: vi.fn(async (fn: string) => {
      if (fn in over) return over[fn];
      if (fn === "finish_panel_account_outbox") return { data: "done", error: null };
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    }),
  };
}

beforeEach(() => {
  engine.send = vi.fn(async () => ({ kind: "done", result: { ok: true, found: true, changed: true, userId: "u-9" }, replayed: false }));
});

describe("buildDeactivateCommand", () => {
  it("customer.deactivate for the email, Billing's customer id, reason personal-erase; one id per customer per IST day", () => {
    const cmd = buildDeactivateCommand(ROW, new Date("2026-10-29T20:00:00Z"))!; // 30 Oct in IST
    expect(cmd).toEqual({
      commandId: "rsos-deact-cust-1-20261030",
      command: "customer.deactivate",
      subject: "asha@example.invalid",
      mode: "live",
      payload: { customerId: "C-00007", reason: "personal-erase", sourceRef: "cust-1" },
    });
    expect(panelDeactivateCommandId("cust-1", new Date("2026-10-29T10:00:00Z"))).toBe("rsos-deact-cust-1-20261029");
  });
  it("no valid email → null (never sent)", () => {
    expect(buildDeactivateCommand({ ...ROW, email: null })).toBeNull();
  });
});

describe("processPanelAccountRow with op deactivate", () => {
  it("sends customer.deactivate (not ensure) and records done", async () => {
    const db = fakeDb();
    const out = emptyProcessResult();
    await processPanelAccountRow(db as never, ROW, out, new Date("2026-10-30T06:00:00Z"));
    expect(engine.send).toHaveBeenCalledTimes(1);
    expect(engine.send!.mock.calls[0][0]).toMatchObject({ command: "customer.deactivate", commandId: "rsos-deact-cust-1-20261030" });
    expect(db.rpc).toHaveBeenCalledWith("finish_panel_account_outbox", { p_id: "o1", p_result: "done", p_dms_user_id: "u-9", p_error: null });
    expect(out.done).toBe(1);
  });

  it("a retry the same day reuses the commandId (DMS replays, nothing done twice)", async () => {
    const t = new Date("2026-10-30T06:00:00Z");
    await processPanelAccountRow(fakeDb() as never, ROW, emptyProcessResult(), t);
    await processPanelAccountRow(fakeDb() as never, { ...ROW, attempts: 1 }, emptyProcessResult(), new Date(t.getTime() + 3600_000));
    const ids = engine.send!.mock.calls.map((c) => (c[0] as { commandId: string }).commandId);
    expect(new Set(ids).size).toBe(1);
  });

  it("an ensure row (op absent = ensure) still sends customer.ensure", async () => {
    const { op: _op, ...ensureRow } = ROW;
    await processPanelAccountRow(fakeDb() as never, { ...ensureRow, customer_name: "Asha" } as PanelAccountRow, emptyProcessResult());
    expect(engine.send!.mock.calls[0][0]).toMatchObject({ command: "customer.ensure" });
  });
});

describe("queuePanelAccountDeactivate (called by the personal erase)", () => {
  it("queues through the service-role RPC and returns its answer", async () => {
    const db = fakeDb({ queue_panel_account_deactivate: { data: "queued", error: null } });
    await expect(queuePanelAccountDeactivate(db as never, { tenantId: "T1", customerId: "cust-1" })).resolves.toBe("queued");
    expect(db.rpc).toHaveBeenCalledWith("queue_panel_account_deactivate", { p_tenant_id: "T1", p_customer_id: "cust-1" });
  });
  it("throws when the RPC fails, so the erase does not report success silently", async () => {
    const db = fakeDb({ queue_panel_account_deactivate: { data: null, error: { message: "boom" } } });
    await expect(queuePanelAccountDeactivate(db as never, { tenantId: "T1", customerId: "cust-1" })).rejects.toThrow(/boom/);
  });
});
