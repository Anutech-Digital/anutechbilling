/**
 * The register-domains worker (24 Sep 2026, owner decision 21).
 *
 * Pinned: it sends nothing while either switch is off or the workspace's
 * automation is off; it sends exactly one live command per ready row with a
 * stable, day-keyed id; and each engine answer becomes the right queue state —
 * done → activated, hold → note (still queued), lost response → note + owner
 * alert, refusal → failed + owner alert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
/* R-897: customer messages switched ON for these tests (the gate has its own tests). */
vi.mock("@/lib/automation/gate.server", () => ({
  automationState: async () => "on",
  cronTenants: async () => ({ on: [], dry: [] }),
  recordRun: async () => {},
  readJobRow: async () => null,
  ensureDefaultOnRow: async () => {},
  readTenantJobs: async () => [],
}));
/* R-897: route logic under test — the automation gate is passed through here; it has its own tests (_lib/automation-gate.test.ts). */
vi.mock("@/lib/automation/cron-gate", () => ({
  gatedCron: (_job: string, h: unknown) => h,
  cronTenantAllowed: () => true,
  isCronDryRun: () => false,
  noteWouldSend: () => {},
  currentCronRun: () => null,
}));

const prov = vi.hoisted(() => ({
  listReadyDomainRequests: vi.fn(),
  markProvisioningActivated: vi.fn(),
  markProvisioningFailed: vi.fn(),
  noteProvisioning: vi.fn(),
}));
vi.mock("@/lib/provisioning/provisioning.server", () => prov);

const engine = vi.hoisted(() => ({ sendEngineCommand: vi.fn(), commandsConfigured: vi.fn() }));
vi.mock("@/lib/dms-engine/commands", () => engine);

const autonomy = vi.hoisted(() => ({ loadAutonomyPolicy: vi.fn() }));
vi.mock("@/lib/ai/autonomy.server", () => autonomy);

const mail = vi.hoisted(() => ({ sendEmail: vi.fn(), loadOwnerAlert: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendEmail: mail.sendEmail }));
vi.mock("@/lib/email/owner-alert.server", () => ({ loadOwnerAlert: mail.loadOwnerAlert }));

const quoteRow = vi.hoisted(() => ({ value: null as unknown }));
const customerRow = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (t: string) => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: t === "customers" ? customerRow.value : quoteRow.value, error: null }) }) }) }) }),
  }),
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

import { GET } from "./route";

const registrant = { firstName: "A", lastName: "B", email: "a@example.invalid", phone: "9999999999", phoneCc: "91", address: { line1: "x", city: "y", state: "z", country: "IN", zipcode: "110001" } };
const row = { id: "R1", tenant_id: "T1", quote_id: "Q1", domain: "acme.in", amount_paid: 708, note: null };
const req = () => new Request("https://example.invalid/api/cron/register-domains", { headers: { authorization: "Bearer s3cret" } });

const ENV = { ...process.env };
beforeEach(() => {
  for (const f of [...Object.values(prov), ...Object.values(engine), autonomy.loadAutonomyPolicy, mail.sendEmail, mail.loadOwnerAlert]) f.mockReset();
  process.env.CRON_SECRET = "s3cret";
  process.env.DOMAIN_REGISTRATION_LIVE = "1";
  engine.commandsConfigured.mockReturnValue(true);
  prov.listReadyDomainRequests.mockResolvedValue([row]);
  prov.noteProvisioning.mockResolvedValue(true);
  autonomy.loadAutonomyPolicy.mockResolvedValue({ killSwitch: false, modes: {} });
  mail.loadOwnerAlert.mockResolvedValue({ alert: { ok: true, to: "owner@example.invalid" } });
  mail.sendEmail.mockResolvedValue({ status: "sent" });
  quoteRow.value = { id: "Q1", line_items: [{ domain: "acme.in", registrant }] };
});
afterEach(() => { process.env = { ...ENV }; });

describe("nothing is sent while anything is switched off", () => {
  it("the paying side's switch off → no-op", async () => {
    process.env.DOMAIN_REGISTRATION_LIVE = "";
    const body = await (await GET(req())).json();
    expect(body.note).toMatch(/switched off/);
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
  });
  it("no command key → 503, nothing sent", async () => {
    engine.commandsConfigured.mockReturnValue(false);
    expect((await GET(req())).status).toBe(503);
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
  });
  it("the workspace's automation kill switch → noted, nothing sent", async () => {
    autonomy.loadAutonomyPolicy.mockResolvedValue({ killSwitch: true, modes: {} });
    await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", expect.stringMatching(/automation is switched off/));
  });
  it("no registrant on the quote → held, nothing sent", async () => {
    quoteRow.value = { id: "Q1", line_items: [{ domain: "acme.in" }] };
    await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", expect.stringMatching(/no registrant details/));
  });
  it("unauthenticated → 401", async () => {
    expect((await GET(new Request("https://example.invalid/x"))).status).toBe(401);
  });
});

describe("what it sends", () => {
  it("one live domain.register, day-keyed id, the registrant and the pre-GST cover", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { orderId: "RC-9" }, replayed: false });
    await GET(req());
    expect(engine.sendEngineCommand).toHaveBeenCalledTimes(1);
    const cmd = engine.sendEngineCommand.mock.calls[0][0];
    expect(cmd).toMatchObject({ command: "domain.register", subject: "acme.in", mode: "live" });
    expect(cmd.commandId).toMatch(/^rsos-domreg-R1-\d{4}-\d{2}-\d{2}$/);
    expect(cmd.payload).toMatchObject({ years: 1, registrant, coverRupees: 600, paymentMode: "live", sourceRef: "Q1" });
  });

  it("R-035: a row paid for 3 years registers for 3; a row without years (older) for 1", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { orderId: "RC-9" }, replayed: false });
    prov.listReadyDomainRequests.mockResolvedValue([{ ...row, id: "R3", years: 3 }, { ...row, id: "R0" }]);
    await GET(req());
    expect(engine.sendEngineCommand.mock.calls.map((c) => c[0].payload.years)).toEqual([3, 1]);
  });

  it("R-035: an out-of-range or broken years never registers for more than 1", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { orderId: "RC-9" }, replayed: false });
    prov.listReadyDomainRequests.mockResolvedValue([
      { ...row, id: "Ra", years: 11 }, { ...row, id: "Rb", years: 0 }, { ...row, id: "Rc", years: 2.5 }, { ...row, id: "Rd", years: "3" },
    ]);
    await GET(req());
    expect(engine.sendEngineCommand.mock.calls.map((c) => c[0].payload.years)).toEqual([1, 1, 1, 3]);
  });
});

describe("what it does with the answer", () => {
  it("done → activated with the registrar's order id", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { orderId: "RC-9" }, replayed: false });
    await GET(req());
    expect(prov.markProvisioningActivated).toHaveBeenCalledWith("R1", "RC-9");
    // 25 Sep 2026: the one email on success goes to the CUSTOMER, through the automation
    // dial (domain.registered.send) — never an owner alert.
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    const msg = mail.sendEmail.mock.calls[0][0];
    expect(msg.to).toBe(registrant.email);
    expect(msg.subject).toBe("acme.in is registered");
    expect(msg.automated).toEqual({ tenantId: "T1", action: "domain.registered.send" });
  });
  it("a domain found already registered to this customer → activated, but no email", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { alreadyRegistered: true }, replayed: false });
    await GET(req());
    expect(prov.markProvisioningActivated).toHaveBeenCalledWith("R1", "already-registered");
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });
  it("a failed customer email does not undo the registration", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { orderId: "RC-9" }, replayed: false });
    mail.sendEmail.mockRejectedValue(new Error("smtp down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(prov.markProvisioningActivated).toHaveBeenCalledWith("R1", "RC-9");
  });
  it("held → note, still queued, no alert", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "held", reason: "[held] daily limit" });
    await GET(req());
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", "Held: [held] daily limit");
    expect(prov.markProvisioningFailed).not.toHaveBeenCalled();
    expect(prov.markProvisioningActivated).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });
  it("lost response → note + owner alert, NOT failed (it may have happened)", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "needs_reconciliation", reason: "no answer" });
    await GET(req());
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", expect.stringMatching(/^RECONCILE:/));
    expect(prov.markProvisioningFailed).not.toHaveBeenCalled();
    expect(mail.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringMatching(/needs checking/) }));
  });
  it("refused → failed + owner alert", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "refused", reason: "invalid name" });
    await GET(req());
    expect(prov.markProvisioningFailed).toHaveBeenCalledWith("R1", expect.stringMatching(/refused/));
    expect(mail.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringMatching(/refused/) }));
  });
  it("the engine's own gate closed → stops the whole run", async () => {
    prov.listReadyDomainRequests.mockResolvedValue([row, { ...row, id: "R2" }]);
    engine.sendEngineCommand.mockResolvedValue({ kind: "gate_closed", reason: "ENGINE_DOMAIN_REGISTER_LIVE" });
    await GET(req());
    expect(engine.sendEngineCommand).toHaveBeenCalledTimes(1);
  });
});

/* R-1552 / R-1587 (18 Oct 2026) */
const hb = vi.hoisted(() => ({ pingHeartbeat: vi.fn() }));
vi.mock("@/lib/ops/heartbeat", () => hb);

describe("R-1552: only the cron secret runs it (the route's own check, behind the gate)", () => {
  it("no bearer → 401, nothing listed", async () => {
    const res = await GET(new Request("https://example.invalid/api/cron/register-domains"));
    expect(res.status).toBe(401);
    expect(prov.listReadyDomainRequests).not.toHaveBeenCalled();
  });
  it("CRON_SECRET unset → 503, nothing listed", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(req())).status).toBe(503);
    expect(prov.listReadyDomainRequests).not.toHaveBeenCalled();
  });
});

describe("R-1587: a DMS outage is heard", () => {
  it("DMS down for every row → 503, a [cron/register-domains] stderr line, heartbeat fail", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    hb.pingHeartbeat.mockReset();
    engine.sendEngineCommand.mockResolvedValue({ kind: "unreachable", reason: "connect ECONNREFUSED" });
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ dmsUnreachable: true, failed: 0 });
    expect(body.errors).toEqual([expect.stringMatching(/acme\.in: could not reach the DMS engine/)]);
    expect(err.mock.calls.some((c) => String(c[0]).startsWith("[cron/register-domains] errors=1"))).toBe(true);
    expect(hb.pingHeartbeat).toHaveBeenCalledWith("register-domains", false);
    err.mockRestore();
  });
  it("a refusal is reported as failed, still 200", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    hb.pingHeartbeat.mockReset();
    engine.sendEngineCommand.mockResolvedValue({ kind: "refused", reason: "quota" });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ failed: 1, refused: 1 });
    expect(err.mock.calls.some((c) => String(c[0]).startsWith("[cron/register-domains] failed=1"))).toBe(true);
    expect(hb.pingHeartbeat).toHaveBeenCalledWith("register-domains", false);
    err.mockRestore();
  });
  it("a clean run pings the heartbeat ok", async () => {
    hb.pingHeartbeat.mockReset();
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { orderId: "RC-1" }, replayed: false });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(hb.pingHeartbeat).toHaveBeenCalledWith("register-domains", true);
  });
  it("the queue read throws → reported 5xx, not a silent 200", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    hb.pingHeartbeat.mockReset();
    prov.listReadyDomainRequests.mockRejectedValue(new TypeError("fetch failed"));
    const res = await GET(req());
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(hb.pingHeartbeat).toHaveBeenCalledWith("register-domains", false);
    err.mockRestore();
  });
});

describe("R-1771: the command names the ResellerOS customer, so DMS links its account by ID", () => {
  beforeEach(() => {
    customerRow.value = null;
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: {}, replayed: true });
  });
  it("paid quote of customer C-00007 → payload.billingCustomerId = C-00007", async () => {
    quoteRow.value = { id: "Q1", customer_id: "cust-1", line_items: [{ domain: "acme.in", registrant }] };
    customerRow.value = { id: "cust-1", customer_number: "C-00007" };
    await GET(req());
    const cmd = engine.sendEngineCommand.mock.calls[0][0];
    expect(cmd.payload).toMatchObject({ registrant, billingCustomerId: "C-00007", sourceRef: "Q1" });
  });
  it("quote not linked to a customer → no field, still sent", async () => {
    await GET(req());
    expect(engine.sendEngineCommand.mock.calls[0][0].payload).not.toHaveProperty("billingCustomerId");
  });
});
