/**
 * R-2103: ensurePanelAccount — the Razorpay webhook's immediate call — and the pure helpers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const engine = vi.hoisted(() => ({ configured: true, send: null as null | ReturnType<typeof vi.fn> }));
vi.mock("@/lib/dms-engine/commands", () => ({
  commandsConfigured: () => engine.configured,
  sendEngineCommand: (...a: unknown[]) => engine.send!(...a),
}));
const sw = vi.hoisted(() => ({ state: "on" as "on" | "off" | "dry_run" }));
vi.mock("@/lib/automation/gate.server", () => ({ automationState: async () => sw.state }));

import { buildEnsureCommand, ensurePanelAccount, finishFor, panelAccountCommandId, type PanelAccountRow } from "./panel-account.server";

const ENV = { ...process.env };
const ROW: PanelAccountRow = {
  id: "o1", tenant_id: "T1", customer_id: "cust-1", attempts: 0, email: " Asha@Example.invalid ",
  customer_name: "Asha Traders", contact_name: null, contact_first_name: "Asha", contact_last_name: null,
  phone: "09876543210", gstin: "07ABCDE1234F1Z5", state: "Delhi", address: "12 MG Road", city: "New Delhi",
  pin_code: "110001", country: "India", customer_number: null,
};

function fakeDb(claimRows: unknown[]) {
  return {
    rpc: vi.fn(async (fn: string) => {
      if (fn === "claim_panel_account_outbox") return { data: claimRows, error: null };
      if (fn === "finish_panel_account_outbox") return { data: "done", error: null };
      if (fn === "mark_panel_account_linked") return { data: "done", error: null };
      return { data: null, error: { message: fn } };
    }),
  };
}

beforeEach(() => {
  process.env.PANEL_ACCOUNTS_LIVE = "1";
  engine.configured = true;
  engine.send = vi.fn(async () => ({ kind: "done", result: { userId: "u-9", created: false }, replayed: false }));
  sw.state = "on";
});
afterEach(() => { process.env = { ...ENV }; });

describe("buildEnsureCommand", () => {
  it("one id per customer per IST day; GSTIN, state and address go along; email lower-cased", () => {
    const cmd = buildEnsureCommand(ROW, new Date("2026-10-29T20:00:00Z"))!; // already 30 Oct in IST
    expect(cmd.commandId).toBe("rsos-acct-cust-1-20261030");
    expect(panelAccountCommandId("cust-1", new Date("2026-10-29T10:00:00Z"))).toBe("rsos-acct-cust-1-20261029");
    expect(cmd.subject).toBe("asha@example.invalid");
    expect(cmd.payload.customer).toMatchObject({
      firstName: "Asha", lastName: "Asha", phone: "9876543210", gstin: "07ABCDE1234F1Z5", state: "Delhi",
      address: { line1: "12 MG Road", city: "New Delhi", zipcode: "110001", country: "IN" }, billingCustomerId: "cust-1",
    });
  });
  it("no valid email → null (never sent)", () => {
    expect(buildEnsureCommand({ ...ROW, email: null })).toBeNull();
    expect(buildEnsureCommand({ ...ROW, email: "asha@nodot" })).toBeNull();
  });
});

describe("finishFor", () => {
  it("maps engine answers", () => {
    expect(finishFor({ kind: "done", result: { userId: "u" }, replayed: true })).toEqual({ result: "done", dmsUserId: "u", error: null });
    expect(finishFor({ kind: "held", reason: "[held] x" }).result).toBe("wait");
    expect(finishFor({ kind: "busy", reason: "x" }).result).toBe("wait");
    expect(finishFor({ kind: "refused", reason: "x" }).result).toBe("retry");
    expect(finishFor({ kind: "needs_reconciliation", reason: "x" }).result).toBe("retry");
  });
});

describe("ensurePanelAccount (webhook, right after settle)", () => {
  it("claims this customer's row only and sends it", async () => {
    const db = fakeDb([ROW]);
    const out = await ensurePanelAccount(db, { tenantId: "T1", customerId: "cust-1" });
    expect(out.kind).toBe("sent");
    expect(db.rpc).toHaveBeenCalledWith("claim_panel_account_outbox", { p_limit: 1, p_tenant_ids: ["T1"], p_customer_id: "cust-1" });
    expect(engine.send).toHaveBeenCalledTimes(1);
  });

  it("dms-panel order: marks the row done with the buyer's DMS user, sends nothing", async () => {
    const db = fakeDb([ROW]);
    const out = await ensurePanelAccount(db, { tenantId: "T1", customerId: "cust-1", dmsUserId: "dms-42" });
    expect(out.kind).toBe("linked");
    expect(db.rpc).toHaveBeenCalledWith("mark_panel_account_linked", { p_tenant_id: "T1", p_customer_id: "cust-1", p_dms_user_id: "dms-42" });
    expect(engine.send).not.toHaveBeenCalled();
  });

  it("flag off, key missing or switch not on → nothing claimed or sent", async () => {
    const setups = [
      () => { process.env.PANEL_ACCOUNTS_LIVE = ""; },
      () => { engine.configured = false; },
      () => { sw.state = "dry_run"; },
    ];
    for (const setup of setups) {
      process.env.PANEL_ACCOUNTS_LIVE = "1"; engine.configured = true; sw.state = "on";
      setup();
      const db = fakeDb([ROW]);
      const out = await ensurePanelAccount(db, { tenantId: "T1", customerId: "cust-1" });
      expect(out.kind).toBe("skipped");
      expect(db.rpc).not.toHaveBeenCalled();
    }
    expect(engine.send).not.toHaveBeenCalled();
  });

  it("never throws and never waits past the cap", async () => {
    const boom = { rpc: vi.fn(async () => { throw new Error("db down"); }) };
    expect((await ensurePanelAccount(boom, { tenantId: "T1", customerId: "cust-1" })).kind).toBe("skipped");

    engine.send = vi.fn(() => new Promise(() => {}));
    const slow = await ensurePanelAccount(fakeDb([ROW]), { tenantId: "T1", customerId: "cust-1" }, { timeoutMs: 20 });
    expect(slow).toMatchObject({ kind: "skipped" });
  });

  it("webhook passes the quote: its customer is read inside the tenant, then sent", async () => {
    const eqs: unknown[][] = [];
    const db = {
      ...fakeDb([ROW]),
      from: (t: string) => ({ select: () => ({ eq: (a: string, b: unknown) => (eqs.push([t, a, b]), { eq: (c: string, d: unknown) => (eqs.push([t, c, d]), { maybeSingle: async () => ({ data: { customer_id: "cust-1" }, error: null }) }) }) }) }),
    };
    const out = await ensurePanelAccount(db, { tenantId: "T1", quoteId: "Q-1" });
    expect(out.kind).toBe("sent");
    expect(eqs).toEqual([["quotes", "id", "Q-1"], ["quotes", "tenant_id", "T1"]]);
    expect(db.rpc).toHaveBeenCalledWith("claim_panel_account_outbox", { p_limit: 1, p_tenant_ids: ["T1"], p_customer_id: "cust-1" });
  });

  it("no customer on the order → skipped", async () => {
    expect((await ensurePanelAccount(fakeDb([]), { tenantId: "T1", customerId: null })).kind).toBe("skipped");
  });
});
