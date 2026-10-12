/**
 * The renew-hosting worker (25 Sep 2026). Pinned: nothing is sent while a switch is off; the
 * term comes from the renewal quote's line (never guessed); the account's CURRENT expiry, read
 * from DMS, is sent as `expiryBefore`; each engine answer becomes the right queue state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
/* R-897: route logic under test — the automation gate is passed through here; it has its own tests (_lib/automation-gate.test.ts). */
vi.mock("@/lib/automation/cron-gate", () => ({
  gatedCron: (_job: string, h: unknown) => h,
  cronTenantAllowed: () => true,
  isCronDryRun: () => false,
  noteWouldSend: () => {},
}));

const prov = vi.hoisted(() => ({
  listReadyHostingRenewals: vi.fn(),
  markProvisioningActivated: vi.fn(),
  markProvisioningFailed: vi.fn(),
  noteProvisioning: vi.fn(),
}));
vi.mock("@/lib/provisioning/provisioning.server", () => prov);

const engine = vi.hoisted(() => ({ sendEngineCommand: vi.fn(), commandsConfigured: vi.fn() }));
vi.mock("@/lib/dms-engine/commands", () => engine);
const client = vi.hoisted(() => ({ getEngineServices: vi.fn() }));
vi.mock("@/lib/dms-engine/client", () => client);

const autonomy = vi.hoisted(() => ({ loadAutonomyPolicy: vi.fn() }));
vi.mock("@/lib/ai/autonomy.server", () => autonomy);

const mail = vi.hoisted(() => ({ sendEmail: vi.fn(), loadOwnerAlert: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendEmail: mail.sendEmail }));
vi.mock("@/lib/email/owner-alert.server", () => ({ loadOwnerAlert: mail.loadOwnerAlert }));

const rows = vi.hoisted(() => ({ quote: { id: "Q9", customer_id: "C1", line_items: [{ commitment: "annual_yearly" }] } as unknown, customer: { contact_email: "buyer@example.invalid" } as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "quotes" ? rows.quote : rows.customer, error: null }) }) }) }),
    }),
  }),
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

import { GET } from "./route";

const row = { id: "R1", tenant_id: "T1", quote_id: "Q9", domain: "acme.in", plan: "hosting-renewal" };
const req = () => new Request("https://example.invalid/api/cron/renew-hosting", { headers: { authorization: "Bearer s3cret" } });
const services = (expiryDate: string | null, status = "active") => ({
  ok: true,
  data: { linked: true, domains: [], hostings: [{ id: "H1", domainName: "acme.in", planName: "Starter", status, startDate: null, expiryDate, autoRenew: false, isTrial: false, directAdminUsername: "acmeu" }] },
});

const ENV = { ...process.env };
beforeEach(() => {
  for (const f of [...Object.values(prov), ...Object.values(engine), client.getEngineServices, autonomy.loadAutonomyPolicy, mail.sendEmail, mail.loadOwnerAlert]) f.mockReset();
  process.env.CRON_SECRET = "s3cret";
  process.env.HOSTING_RENEWAL_LIVE = "1";
  engine.commandsConfigured.mockReturnValue(true);
  prov.listReadyHostingRenewals.mockResolvedValue([row]);
  prov.noteProvisioning.mockResolvedValue(true);
  autonomy.loadAutonomyPolicy.mockResolvedValue({ killSwitch: false, modes: {} });
  mail.loadOwnerAlert.mockResolvedValue({ alert: { ok: true, to: "owner@example.invalid" } });
  mail.sendEmail.mockResolvedValue({ status: "sent" });
  client.getEngineServices.mockResolvedValue(services("2027-09-25T00:00:00.000Z"));
  rows.quote = { id: "Q9", customer_id: "C1", line_items: [{ commitment: "annual_yearly" }] };
  rows.customer = { contact_email: "buyer@example.invalid" };
});
afterEach(() => { process.env = { ...ENV }; });

describe("nothing is sent while anything is switched off", () => {
  it("HOSTING_RENEWAL_LIVE not exactly 1 → no-op", async () => {
    process.env.HOSTING_RENEWAL_LIVE = "true";
    const body = await (await GET(req())).json();
    expect(body.note).toMatch(/switched off/);
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
  });
  it("no command key → 503", async () => {
    engine.commandsConfigured.mockReturnValue(false);
    expect((await GET(req())).status).toBe(503);
  });
  it("the workspace's kill switch → noted, nothing sent", async () => {
    autonomy.loadAutonomyPolicy.mockResolvedValue({ killSwitch: true, modes: {} });
    await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
  });
});

describe("the expiry sent is the one DMS holds — never guessed", () => {
  it("sends hosting.renew with the quote's term, the DMS expiry in epoch seconds, live mode, day-keyed id", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { expiryAfter: "2028-09-25T00:00:00.000Z" } });
    await GET(req());
    const cmd = engine.sendEngineCommand.mock.calls[0][0];
    expect(cmd).toMatchObject({ command: "hosting.renew", subject: "acme.in", mode: "live" });
    expect(cmd.commandId).toMatch(/^rsos-hostrenew-R1-\d{4}-\d{2}-\d{2}$/);
    expect(cmd.payload).toEqual({ months: 12, expiryBefore: 1821830400, paymentMode: "live", sourceRef: "Q9" });
    expect(prov.markProvisioningActivated).toHaveBeenCalledWith("R1", "2028-09-25T00:00:00.000Z");
  });
  it("extended but still suspended → marked done AND the owner is told to unsuspend, not to resend", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { expiryAfter: "2028-09-25T00:00:00.000Z", unsuspended: false, unsuspendError: "DirectAdmin refused the unsuspend" } });
    await GET(req());
    expect(prov.markProvisioningActivated).toHaveBeenCalledWith("R1", "2028-09-25T00:00:00.000Z");
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", expect.stringMatching(/still SUSPENDED/));
    expect(mail.sendEmail.mock.calls[0][0].text).toMatch(/Do not send the renewal again/);
  });
  it("a clean extension sends no alert", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { expiryAfter: "2028-09-25T00:00:00.000Z", unsuspended: false } });
    await GET(req());
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("a MONTHLY renewal extends by 1 month, not 12", async () => {
    rows.quote = { id: "Q9", customer_id: "C1", line_items: [{ commitment: "monthly" }] };
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: {} });
    await GET(req());
    expect(engine.sendEngineCommand.mock.calls[0][0].payload.months).toBe(1);
  });
  it("no clear term on the quote → held, nothing sent", async () => {
    rows.quote = { id: "Q9", customer_id: "C1", line_items: [{ name: "x" }] };
    await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", expect.stringMatching(/one clear term/));
  });
  it("DMS has no expiry for the hosting → held, nothing sent", async () => {
    client.getEngineServices.mockResolvedValue(services(null));
    await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", expect.stringMatching(/no expiry date/));
  });
  it("DMS holds no live hosting on the domain for this customer → held (a terminated one does not count)", async () => {
    client.getEngineServices.mockResolvedValue(services("2027-09-25T00:00:00.000Z", "terminated"));
    await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", expect.stringMatching(/no hosting account/));
  });
  it("DMS unreachable → waits for the next run, nothing sent", async () => {
    client.getEngineServices.mockResolvedValue({ ok: false, reason: "unreachable" });
    await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
  });
  it("the customer has no email → held", async () => {
    rows.customer = { contact_email: "" };
    await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
  });
});

describe("each engine answer lands in the right queue state", () => {
  it("held → note, still queued", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "held", reason: "[held] daily cap" });
    await GET(req());
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", "Held: [held] daily cap");
    expect(prov.markProvisioningActivated).not.toHaveBeenCalled();
  });
  it("lost response → RECONCILE note + owner told not to renew by hand", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "needs_reconciliation", reason: "socket closed" });
    await GET(req());
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", "RECONCILE: socket closed");
    expect(mail.sendEmail.mock.calls[0][0].text).toMatch(/moved on by 12 month/);
  });
  it("refused → failed + owner alert", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "refused", reason: "already extended since you read it" });
    await GET(req());
    expect(prov.markProvisioningFailed).toHaveBeenCalled();
    expect(mail.sendEmail).toHaveBeenCalled();
  });
  it("engine gate closed → stops the run", async () => {
    prov.listReadyHostingRenewals.mockResolvedValue([row, { ...row, id: "R2" }]);
    engine.sendEngineCommand.mockResolvedValue({ kind: "gate_closed", reason: "ENGINE_HOSTING_RENEW_LIVE" });
    const body = await (await GET(req())).json();
    expect(body.note).toMatch(/gate is closed/);
    expect(engine.sendEngineCommand).toHaveBeenCalledTimes(1);
  });
});
