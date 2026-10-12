/**
 * R-897: every cron route asks the automation gate FIRST.
 *
 * With every switch OFF (the default — a missing row is off), each route answers
 * 200 { skipped: "off" } and never reaches the database, the email sender or WhatsApp.
 * The route is imported for real and called with the real cron secret; only the switch
 * read and the outside world are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  cronTenants: vi.fn(async () => ({ on: [] as string[], dry: [] as string[] })),
  recordRun: vi.fn(async () => {}),
  sendEmail: vi.fn(async () => ({ status: "sent", providerId: "x", errorMessage: null, provider: "resend" })),
  sendWhatsApp: vi.fn(async () => ({ ok: true })),
  adminClient: vi.fn(() => { throw new Error("database touched while the job is OFF"); }),
  bareClient: vi.fn(() => { throw new Error("database touched while the job is OFF"); }),
}));

vi.mock("@/lib/automation/gate.server", () => ({
  cronTenants: h.cronTenants,
  recordRun: h.recordRun,
  readTenantJobs: vi.fn(),
  automationState: vi.fn(async () => "off"),
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: h.sendEmail, isEmailConfigured: () => true }));
vi.mock("@/lib/whatsapp/client", () => ({
  sendWhatsApp: h.sendWhatsApp, resolveWhatsAppCreds: vi.fn(async () => null), toE164: (s: string) => s,
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: h.adminClient, createAdminClientFor: h.adminClient, createClient: h.adminClient,
}));
vi.mock("@/lib/supabase/bare", () => ({ createBareClient: h.bareClient }));

const CRON = join(process.cwd(), "src", "app", "api", "cron");
const JOBS = readdirSync(CRON, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
  .map((d) => d.name);

beforeEach(() => {
  process.env.CRON_SECRET = "r897-test-secret";
  vi.clearAllMocks();
});

const call = (job: string) =>
  new NextRequest(`http://localhost/api/cron/${job}`, { headers: { authorization: "Bearer r897-test-secret" } });

describe("every cron route is gated", () => {
  it("there are cron routes to check", () => {
    expect(JOBS.length).toBeGreaterThanOrEqual(27);
  });

  it.each(JOBS)("%s: gate off → 200 skipped, nothing read, nothing sent", async (job) => {
    const mod = (await import(`../${job}/route`)) as { GET?: (r: NextRequest) => Promise<Response>; POST?: (r: NextRequest) => Promise<Response> };
    const handlers = [mod.GET, mod.POST].filter(Boolean) as ((r: NextRequest) => Promise<Response>)[];
    expect(handlers.length).toBeGreaterThan(0);
    for (const fn of handlers) {
      const res = await fn(call(job));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ skipped: "off", job });
    }
    expect(h.cronTenants).toHaveBeenCalledWith(job);
    expect(h.recordRun).toHaveBeenCalledWith(job, expect.any(Array), "Skipped — turned off");
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.sendWhatsApp).not.toHaveBeenCalled();
    expect(h.adminClient).not.toHaveBeenCalled();
    expect(h.bareClient).not.toHaveBeenCalled();
  }, 60_000);

  it.each(JOBS)("%s: the gate is the exported handler (source)", (job) => {
    const src = readFileSync(join(CRON, job, "route.ts"), "utf8");
    expect(src).toContain(`gatedCron("${job}"`);
    expect(src).not.toMatch(/export const (GET|POST) = handle;/);
    expect(src).not.toMatch(/export async function (GET|POST)\([^)]*\)\s*\{\s*return handle\(/);
  });

  it("the switches cannot be read → 503 and nothing runs", async () => {
    h.cronTenants.mockResolvedValueOnce(null as never);
    const mod = await import("../invoice-dunning/route");
    const res = await mod.GET(call("invoice-dunning"));
    expect(res.status).toBe(503);
    expect(h.adminClient).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("no cron secret → the route's own 401, the gate records nothing", async () => {
    const mod = await import("../invoice-dunning/route");
    const res = await mod.GET(new NextRequest("http://localhost/api/cron/invoice-dunning"));
    expect(res.status).toBe(401);
    expect(h.cronTenants).not.toHaveBeenCalled();
    expect(h.recordRun).not.toHaveBeenCalled();
  });
});
