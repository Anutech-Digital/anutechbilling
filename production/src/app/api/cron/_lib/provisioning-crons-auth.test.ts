/**
 * R-1552 (18 Oct 2026, security audit F1): the four provisioning crons (register-domains,
 * renew-domains, provision-hosting, renew-hosting) took CRON_SECRET *or any signed-in owner
 * of any company*. With no bearer the automation gate handed the request straight to the
 * route, outside any run context, so cronTenantAllowed() said yes to every company and the
 * route sent live DMS commands for ALL companies' paid orders — automation switch ignored.
 *
 * Pinned here with the REAL gate (only the switch read and the outside world are mocked):
 *   · a signed-in owner without the cron bearer → refused, nothing listed, nothing sent;
 *   · no / wrong bearer → 401; CRON_SECRET unset → 503 (fail closed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  cronTenants: vi.fn(async () => ({ on: ["T1"] as string[], dry: [] as string[] })),
  recordRun: vi.fn(async () => {}),
  list: vi.fn(async () => [] as unknown[]),
  send: vi.fn(),
}));

vi.mock("@/lib/automation/gate.server", () => ({
  cronTenants: h.cronTenants,
  recordRun: h.recordRun,
  readJobRow: vi.fn(async () => null),
  ensureDefaultOnRow: vi.fn(async () => {}),
  readTenantJobs: vi.fn(async () => []),
  automationState: vi.fn(async () => "on"),
}));
vi.mock("@/lib/provisioning/provisioning.server", () => ({
  listReadyDomainRequests: h.list,
  listReadyDomainRenewals: h.list,
  listReadyHostingRequests: h.list,
  listReadyHostingRenewals: h.list,
  markProvisioningActivated: vi.fn(),
  markProvisioningFailed: vi.fn(),
  noteProvisioning: vi.fn(async () => true),
}));
vi.mock("@/lib/dms-engine/commands", () => ({ commandsConfigured: () => true, sendEngineCommand: h.send }));
vi.mock("@/lib/dms-engine/client", () => ({ getEngineServices: vi.fn(), dmsPanelUrl: () => "https://dms.example.invalid" }));
vi.mock("@/lib/ai/autonomy.server", () => ({ loadAutonomyPolicy: vi.fn(async () => ({ killSwitch: false, modes: {} })) }));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/email/owner-alert.server", () => ({ loadOwnerAlert: vi.fn() }));
/* A signed-in OWNER of company T2 — the attacker in the audit finding. */
vi.mock("@/lib/supabase/server", () => {
  const session = {
    auth: { getUser: async () => ({ data: { user: { id: "U2" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { role: "owner", tenant_id: "T2" }, error: null }) }) }) }),
  };
  return { createClient: () => session, createAdminClient: () => ({ from: () => { throw new Error("admin client used"); } }) };
});

const JOBS = ["register-domains", "renew-domains", "provision-hosting", "renew-hosting"] as const;
const ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "r1552-secret";
  process.env.DOMAIN_REGISTRATION_LIVE = "1";
  process.env.DOMAIN_RENEWAL_LIVE = "1";
  process.env.HOSTING_PROVISIONING_LIVE = "1";
  process.env.HOSTING_RENEWAL_LIVE = "1";
});
afterEach(() => { process.env = { ...ENV }; });

type Route = { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> };
const load = (job: string) => import(`../${job}/route`) as Promise<Route>;
const url = (job: string) => `http://localhost/api/cron/${job}`;

describe("R-1552: provisioning crons answer only the cron secret", () => {
  it.each(JOBS)("%s: a signed-in owner (no bearer) is refused and nothing runs", async (job) => {
    const route = await load(job);
    for (const fn of [route.GET, route.POST]) {
      const res = await fn(new NextRequest(url(job), { method: "POST" }));
      expect(res.status).toBe(401);
    }
    expect(h.list).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.cronTenants).not.toHaveBeenCalled();
    expect(h.recordRun).not.toHaveBeenCalled();
  });

  it.each(JOBS)("%s: a wrong bearer is 401, nothing runs", async (job) => {
    const res = await (await load(job)).GET(new NextRequest(url(job), { headers: { authorization: "Bearer nope" } }));
    expect(res.status).toBe(401);
    expect(h.list).not.toHaveBeenCalled();
  });

  it.each(JOBS)("%s: CRON_SECRET unset → 503 (fail closed), even for a signed-in owner", async (job) => {
    delete process.env.CRON_SECRET;
    const res = await (await load(job)).GET(new NextRequest(url(job)));
    expect(res.status).toBe(503);
    expect(h.list).not.toHaveBeenCalled();
  });

  it.each(JOBS)("%s: the right bearer runs through the gate, for the switched-on companies only", async (job) => {
    const res = await (await load(job)).GET(new NextRequest(url(job), { headers: { authorization: "Bearer r1552-secret" } }));
    expect(res.status).toBe(200);
    expect(h.cronTenants).toHaveBeenCalledWith(job);
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.recordRun).toHaveBeenCalledWith(job, ["T1"], expect.any(String));
  });
});
