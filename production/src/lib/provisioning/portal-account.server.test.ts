/** The Customer Portal login at payment time (7 Oct 2026) — ResellerOS's half. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendEngineCommand = vi.hoisted(() => vi.fn());
const commandsConfigured = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/dms-engine/commands", () => ({ sendEngineCommand, commandsConfigured }));

import { ensurePortalAccount, portalAccountCommandId } from "./portal-account.server";

const lead = { contact_name: "Asha Verma", contact_email: "Asha@Example.in", contact_phone: "+91 98111 22233", company: "Asha Co" };
const admin = () => ({
  from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: lead }) }) }) }) }),
}) as never;
const input = (over = {}) => ({ tenantId: "T1", quoteId: "Q-1", leadId: "L-1", customerName: "Asha Co", paymentEmail: "pay@example.in", vendors: ["hosting"], ...over });

beforeEach(() => { sendEngineCommand.mockReset(); commandsConfigured.mockReturnValue(true); });

describe("ensurePortalAccount", () => {
  it("asks DMS for the account with the lead's details, once per order", async () => {
    sendEngineCommand.mockResolvedValueOnce({ kind: "done", result: { created: true }, replayed: false });
    expect(await ensurePortalAccount(admin(), input())).toEqual({ kind: "done", created: true });
    expect(sendEngineCommand).toHaveBeenCalledWith({
      commandId: portalAccountCommandId("Q-1"),
      command: "customer.ensure",
      subject: "asha@example.in",
      mode: "live",
      payload: { customer: { firstName: "Asha", lastName: "Verma", email: "asha@example.in", phone: "9811122233", phoneCc: "91", companyName: "Asha Co" }, sourceRef: "Q-1" },
    });
    expect(portalAccountCommandId("Q-1")).toBe("rsos-acct-Q-1");
  });
  it("does nothing for an order with no hosting or domain (Workspace lives elsewhere)", async () => {
    expect((await ensurePortalAccount(admin(), input({ vendors: ["google"] }))).kind).toBe("skipped");
    expect(sendEngineCommand).not.toHaveBeenCalled();
  });
  it("does nothing when the engine is not connected", async () => {
    commandsConfigured.mockReturnValue(false);
    expect((await ensurePortalAccount(admin(), input({ vendors: ["domain"] }))).kind).toBe("skipped");
    expect(sendEngineCommand).not.toHaveBeenCalled();
  });
  it("a refusal or an unreachable engine is reported, not thrown", async () => {
    sendEngineCommand.mockResolvedValueOnce({ kind: "gate_closed", reason: "ENGINE_CUSTOMER_ACCOUNT_LIVE is off" });
    expect(await ensurePortalAccount(admin(), input())).toEqual({ kind: "not_done", reason: "gate_closed: ENGINE_CUSTOMER_ACCOUNT_LIVE is off" });
  });
});
