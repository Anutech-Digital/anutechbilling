/** The Customer Portal login at payment time (7 Oct 2026) — ResellerOS's half. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendEngineCommand = vi.hoisted(() => vi.fn());
const commandsConfigured = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/dms-engine/commands", () => ({ sendEngineCommand, commandsConfigured }));

import { ensurePortalAccount, portalAccountCommandId } from "./portal-account.server";

const lead = { contact_name: "Asha Verma", contact_email: "Asha@Example.in", contact_phone: "+91 98111 22233", company: "Asha Co", gstin: null as string | null, state: null as string | null };
let quoteLines: unknown[] = [];
const admin = () => ({
  from: (table: string) => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "quotes" ? { line_items: quoteLines } : lead }) }) }) }) }),
}) as never;
const input = (over = {}) => ({ tenantId: "T1", quoteId: "Q-1", leadId: "L-1", customerName: "Asha Co", paymentEmail: "pay@example.in", vendors: ["hosting"], ...over });

beforeEach(() => { sendEngineCommand.mockReset(); commandsConfigured.mockReturnValue(true); quoteLines = []; lead.gstin = null; lead.state = null; });

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
  it("sends the GSTIN, state and registrant address this order already has, so the portal reuses them (10 Oct 2026)", async () => {
    lead.gstin = "07abdca0298h1zp"; lead.state = "Delhi";
    quoteLines = [
      { name: "Starter hosting" },
      { name: "Domain asha.in", registrant: { address: { line1: "12 MG Road", city: "New Delhi", state: "Delhi", zipcode: "110001", country: "IN" } } },
    ];
    sendEngineCommand.mockResolvedValueOnce({ kind: "done", result: { created: true }, replayed: false });
    await ensurePortalAccount(admin(), input({ vendors: ["hosting", "domain"] }));
    const customer = sendEngineCommand.mock.calls[0][0].payload.customer;
    expect(customer).toMatchObject({
      gstin: "07ABDCA0298H1ZP",
      state: "Delhi",
      address: { line1: "12 MG Road", city: "New Delhi", state: "Delhi", zipcode: "110001", country: "IN" },
    });
  });
  it("sends nothing it does not have: no made-up GSTIN, no partial address", async () => {
    lead.gstin = "not-a-gstin";
    quoteLines = [{ registrant: { address: { line1: "12 MG Road", city: "", zipcode: "" } } }];
    sendEngineCommand.mockResolvedValueOnce({ kind: "done", result: { created: false }, replayed: false });
    await ensurePortalAccount(admin(), input());
    const customer = sendEngineCommand.mock.calls[0][0].payload.customer;
    expect(customer.gstin).toBeUndefined();
    expect(customer.address).toBeUndefined();
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
