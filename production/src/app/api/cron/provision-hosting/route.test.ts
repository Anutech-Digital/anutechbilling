/**
 * The provision-hosting worker, since 24 Sep 2026 a sender of the DMS engine's
 * `hosting.provision` rather than a DirectAdmin client of its own.
 *
 * Pinned: it never calls DirectAdmin itself; it sends nothing while either
 * switch or the workspace's automation is off; and each engine answer becomes
 * the right queue state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
/* R-897: route logic under test — the automation gate is passed through here; it has its own tests (_lib/automation-gate.test.ts). */
vi.mock("@/lib/automation/cron-gate", () => ({
  gatedCron: (_job: string, h: unknown) => h,
  cronTenantAllowed: () => true,
  isCronDryRun: () => false,
  noteWouldSend: () => {},
  currentCronRun: () => null,
}));
import { readFileSync } from "node:fs";
import { join } from "node:path";

const prov = vi.hoisted(() => ({
  listReadyHostingRequests: vi.fn(),
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

const tables = vi.hoisted(() => ({ quotes: null as unknown, leads: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (t: "quotes" | "leads") => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: tables[t], error: null }) }) }) }),
    }),
  }),
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

import { GET } from "./route";

const row = { id: "R1", tenant_id: "T1", quote_id: "Q1", domain: "acme.in", plan: "hosting-standard" };
const req = () => new Request("https://example.invalid/api/cron/provision-hosting", { headers: { authorization: "Bearer s3cret" } });
const ENV = { ...process.env };

beforeEach(() => {
  for (const f of [...Object.values(prov), ...Object.values(engine), autonomy.loadAutonomyPolicy, mail.sendEmail, mail.loadOwnerAlert]) f.mockReset();
  process.env.CRON_SECRET = "s3cret";
  process.env.HOSTING_PROVISIONING_LIVE = "1";
  engine.commandsConfigured.mockReturnValue(true);
  prov.listReadyHostingRequests.mockResolvedValue([row]);
  prov.noteProvisioning.mockResolvedValue(true);
  autonomy.loadAutonomyPolicy.mockResolvedValue({ killSwitch: false, modes: {} });
  mail.loadOwnerAlert.mockResolvedValue({ alert: { ok: true, to: "owner@example.invalid" } });
  mail.sendEmail.mockResolvedValue({ status: "sent" });
  tables.quotes = { id: "Q1", lead_id: "L1", customer_name: "Acme", domain: null, line_items: [{ name: "Standard hosting (billed monthly)", hostingPlan: "standard", months: 1 }] };
  tables.leads = { contact_name: "Asha Verma", contact_email: "Asha@Example.invalid", contact_phone: "+91 98765 43210", company: "Acme" };
});
afterEach(() => { process.env = { ...ENV }; });

describe("this app no longer writes to DirectAdmin for a sale", () => {
  it("the worker imports no DirectAdmin client", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/cron/provision-hosting/route.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
    expect(src).not.toMatch(/directadmin\/provision|daCreateAccount|genPassword/);
  });
});

describe("nothing is sent while anything is off", () => {
  it("switch off → no-op", async () => {
    process.env.HOSTING_PROVISIONING_LIVE = "true";
    const body = await (await GET(req())).json();
    expect(body.note).toMatch(/switched off/);
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
  });
  it("kill switch → noted, nothing sent", async () => {
    autonomy.loadAutonomyPolicy.mockResolvedValue({ killSwitch: true, modes: {} });
    await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
  });
  it("no buyer email → held, nothing sent", async () => {
    tables.leads = { contact_name: "A" };
    await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", expect.stringMatching(/buyer's email/));
  });
});

describe("what it sends and does", () => {
  it("one live hosting.provision with the plan, months and the buyer", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { daUsername: "acmeiab12c" }, replayed: false });
    await GET(req());
    const cmd = engine.sendEngineCommand.mock.calls[0][0];
    expect(cmd).toMatchObject({ command: "hosting.provision", subject: "acme.in", mode: "live" });
    expect(cmd.commandId).toMatch(/^rsos-hostprov-R1-\d{4}-\d{2}-\d{2}$/);
    expect(cmd.payload).toMatchObject({
      planId: "standard",
      months: 1,
      customer: { firstName: "Asha", lastName: "Verma", email: "asha@example.invalid", phone: "9876543210", phoneCc: "91", companyName: "Acme" },
      paymentMode: "live",
      sourceRef: "Q1",
    });
    expect(prov.markProvisioningActivated).toHaveBeenCalledWith("R1", "acmeiab12c");
  });
  it("R-036: two hosting requests on one order each provision their own plan and domain", async () => {
    tables.quotes = { id: "Q1", lead_id: "L1", customer_name: "Acme", domain: null, line_items: [
      { name: "Starter hosting (billed yearly)", hostingPlan: "starter", months: 12 },
      { name: "Plus hosting (billed monthly)", hostingPlan: "plus", months: 1 },
    ] };
    prov.listReadyHostingRequests.mockResolvedValue([
      { id: "RA", tenant_id: "T1", quote_id: "Q1", domain: "a.in", plan: "hosting-starter" },
      { id: "RB", tenant_id: "T1", quote_id: "Q1", domain: "b.in", plan: "hosting-plus" },
    ]);
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { daUsername: "x" }, replayed: false });
    await GET(req());
    const sent = engine.sendEngineCommand.mock.calls.map((c) => ({ subject: c[0].subject, planId: c[0].payload.planId, months: c[0].payload.months }));
    expect(sent).toEqual([
      { subject: "a.in", planId: "starter", months: 12 },
      { subject: "b.in", planId: "plus", months: 1 },
    ]);
  });

  it("R-032: two Starter plans on two domains — each request finds ITS line by domain", async () => {
    // Same tier, different terms: only the domain tells which line a request belongs to.
    tables.quotes = { id: "Q1", lead_id: "L1", customer_name: "Acme", domain: "a.in", line_items: [
      { name: "Starter hosting (billed yearly)", hostingPlan: "starter", months: 12, domain: "a.in", hostingDomain: "a.in" },
      { name: "Starter hosting (billed monthly)", hostingPlan: "starter", months: 1, domain: "b.in", hostingDomain: "b.in" },
    ] };
    prov.listReadyHostingRequests.mockResolvedValue([
      { id: "RA", tenant_id: "T1", quote_id: "Q1", domain: "a.in", plan: "hosting-starter" },
      { id: "RB", tenant_id: "T1", quote_id: "Q1", domain: "b.in", plan: "hosting-starter" },
    ]);
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { daUsername: "x" }, replayed: false });
    await GET(req());
    const sent = engine.sendEngineCommand.mock.calls.map((c) => ({ subject: c[0].subject, months: c[0].payload.months }));
    expect(sent).toEqual([{ subject: "a.in", months: 12 }, { subject: "b.in", months: 1 }]);
  });

  it("lost response → note + owner alert, not failed", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "needs_reconciliation", reason: "no answer" });
    await GET(req());
    expect(prov.markProvisioningFailed).not.toHaveBeenCalled();
    expect(mail.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringMatching(/needs checking/) }));
  });
  it("refused → failed + owner alert", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "refused", reason: "domain exists" });
    await GET(req());
    expect(prov.markProvisioningFailed).toHaveBeenCalledWith("R1", expect.stringMatching(/refused/));
  });
  it("held → note, still queued", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "held", reason: "[held] test-mode" });
    await GET(req());
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", "Held: [held] test-mode");
    expect(prov.markProvisioningActivated).not.toHaveBeenCalled();
  });
});

/* R-1552 / R-1587 (18 Oct 2026) */
const hb = vi.hoisted(() => ({ pingHeartbeat: vi.fn() }));
vi.mock("@/lib/ops/heartbeat", () => hb);

describe("R-1552: only the cron secret runs it (the route's own check, behind the gate)", () => {
  it("no bearer → 401, nothing listed", async () => {
    const res = await GET(new Request("https://example.invalid/api/cron/provision-hosting"));
    expect(res.status).toBe(401);
    expect(prov.listReadyHostingRequests).not.toHaveBeenCalled();
  });
  it("CRON_SECRET unset → 503, nothing listed", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(req())).status).toBe(503);
    expect(prov.listReadyHostingRequests).not.toHaveBeenCalled();
  });
});

describe("R-1587: a DMS outage is heard", () => {
  it("DMS down for every row → 503, a [cron/provision-hosting] stderr line, heartbeat fail", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    hb.pingHeartbeat.mockReset();
    engine.sendEngineCommand.mockResolvedValue({ kind: "unreachable", reason: "connect ECONNREFUSED" });
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ dmsUnreachable: true, failed: 0 });
    expect(body.errors).toEqual([expect.stringMatching(/acme\.in: could not reach the DMS engine/)]);
    expect(err.mock.calls.some((c) => String(c[0]).startsWith("[cron/provision-hosting] errors=1"))).toBe(true);
    expect(hb.pingHeartbeat).toHaveBeenCalledWith("provision-hosting", false);
    err.mockRestore();
  });
  it("a refusal is reported as failed, still 200", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    hb.pingHeartbeat.mockReset();
    engine.sendEngineCommand.mockResolvedValue({ kind: "refused", reason: "quota" });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ failed: 1, refused: 1 });
    expect(err.mock.calls.some((c) => String(c[0]).startsWith("[cron/provision-hosting] failed=1"))).toBe(true);
    expect(hb.pingHeartbeat).toHaveBeenCalledWith("provision-hosting", false);
    err.mockRestore();
  });
  it("a clean run pings the heartbeat ok", async () => {
    hb.pingHeartbeat.mockReset();
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { daUsername: "x" }, replayed: false });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(hb.pingHeartbeat).toHaveBeenCalledWith("provision-hosting", true);
  });
  it("the queue read throws → reported 5xx, not a silent 200", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    hb.pingHeartbeat.mockReset();
    prov.listReadyHostingRequests.mockRejectedValue(new TypeError("fetch failed"));
    const res = await GET(req());
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(hb.pingHeartbeat).toHaveBeenCalledWith("provision-hosting", false);
    err.mockRestore();
  });
});
