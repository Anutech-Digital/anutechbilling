/**
 * R-1818 (security audit 24 Oct 2026): the cold-calls cron works only on the companies the
 * automation gate allows. Before the fix it looped over EVERY company (listTenantsForJobs) and
 * never asked cronTenantAllowed(), so company A's "Run now" — or any scheduled run while one
 * company had it on — placed live Bolna calls for every company's running campaigns, including
 * companies that had switched AI cold calls off.
 *
 * Bolna is never called: the provider is a stub, runCampaignTick (the code that places calls)
 * is a spy, and fetch throws if anything tries the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const USER = "cccccccc-0000-4000-8000-000000000003";

const h = vi.hoisted(() => ({
  cronTenants: vi.fn(async () => ({ on: [] as string[], dry: [] as string[] })),
  recordRun: vi.fn(async (..._a: unknown[]) => {}),
  readJobRow: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  ensureDefaultOnRow: vi.fn(async (..._a: unknown[]) => {}),
  automationState: vi.fn(async (..._a: unknown[]): Promise<string> => "off"),
  tick: vi.fn(async (_run: unknown, _tenantId: string, _campaignId: string) => ({ placed: 1, finished: 0, failed: 0 })),
}));

vi.mock("@/lib/automation/gate.server", () => ({
  cronTenants: h.cronTenants, recordRun: h.recordRun, readJobRow: h.readJobRow,
  ensureDefaultOnRow: h.ensureDefaultOnRow, automationState: h.automationState,
}));
vi.mock("@/lib/telecall/provider", () => ({
  resolveTelecallProvider: () => ({ name: "bolna", apiKey: "test-not-a-key" }),
}));
vi.mock("@/server/coldcall/coldcall.server", () => ({ runCampaignTick: h.tick }));
vi.mock("@/lib/ops/heartbeat", () => ({ pingHeartbeat: vi.fn(async () => {}) }));
vi.mock("@/server/db/jobs", () => ({
  /* Both companies have a running campaign. */
  listTenantsForJobs: vi.fn(async () => [A, B]),
  withJobsTenant: vi.fn(async (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => fn({
    cold_call_campaigns: { findMany: async () => [{ id: `campaign-${tenantId}` }] },
    cold_call_contacts: { findMany: async () => [] },
  })),
}));

import { POST } from "./route";
import { runManually } from "@/lib/automation/manual-run";

const call = () => new NextRequest("http://localhost/api/cron/cold-calls", {
  method: "POST", headers: { authorization: "Bearer s" },
});
const tenantsCalled = () => h.tick.mock.calls.map((c) => c[1]);

beforeEach(() => {
  process.env.CRON_SECRET = "s";
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network is off in this test — Bolna must never be called"); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("cold-calls cron honours the per-company switch (R-1818)", () => {
  it("scheduled run: A on, B off → only A's campaigns are called", async () => {
    h.cronTenants.mockResolvedValueOnce({ on: [A], dry: [] });
    const res = await POST(call());
    expect(res.status).toBe(200);
    expect(tenantsCalled()).toEqual([A]);
    expect(await res.json()).toMatchObject({ campaigns: 1, placed: 1 });
  });

  it("Run now by A's owner touches A only — even when B has cold calls on", async () => {
    h.automationState.mockResolvedValueOnce("on");
    h.cronTenants.mockResolvedValue({ on: [A, B], dry: [] });
    const res = await runManually({ tenantId: A, userId: USER, trigger: "manual", retryOf: null }, () => POST(call()));
    expect(res.status).toBe(200);
    expect(tenantsCalled()).toEqual([A]);
    expect(h.automationState).toHaveBeenCalledWith(A, "cold-calls");
  });

  it("Run now by B's owner while B is off → nothing is called at all", async () => {
    h.automationState.mockResolvedValueOnce("off");
    const res = await runManually({ tenantId: B, userId: USER, trigger: "manual", retryOf: null }, () => POST(call()));
    expect(await res.json()).toMatchObject({ skipped: "off" });
    expect(h.tick).not.toHaveBeenCalled();
  });

  it("both on → both companies' campaigns run", async () => {
    h.cronTenants.mockResolvedValueOnce({ on: [A, B], dry: [] });
    await POST(call());
    expect(tenantsCalled().sort()).toEqual([A, B].sort());
  });
});
