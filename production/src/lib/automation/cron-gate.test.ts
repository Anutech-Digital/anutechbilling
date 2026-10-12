/**
 * R-897: what the cron gate does when a job is ON, in practice run, or for some companies only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  cronTenants: vi.fn(async () => ({ on: [] as string[], dry: [] as string[] })),
  recordRun: vi.fn(async (..._a: unknown[]) => {}),
  readJobRow: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  ensureDefaultOnRow: vi.fn(async (..._a: unknown[]) => {}),
}));
vi.mock("@/lib/automation/gate.server", () => ({
  cronTenants: h.cronTenants, recordRun: h.recordRun, readJobRow: h.readJobRow, ensureDefaultOnRow: h.ensureDefaultOnRow,
}));

import { gatedCron, cronTenantAllowed, isCronDryRun, noteWouldSend, currentCronRun, summarise } from "./cron-gate";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const call = () => new NextRequest("http://localhost/api/cron/invoice-dunning", { headers: { authorization: "Bearer s" } });

beforeEach(() => {
  process.env.CRON_SECRET = "s";
  delete process.env.BUY_PAGE_TENANT_ID;
  vi.clearAllMocks();
});

describe("gatedCron", () => {
  it("ON for A only: one live pass that may touch A, not B", async () => {
    h.cronTenants.mockResolvedValueOnce({ on: [A], dry: [] });
    const seen: unknown[] = [];
    const handler = vi.fn(async (req: NextRequest) => {
      seen.push({ a: cronTenantAllowed(A), b: cronTenantAllowed(B), dry: isCronDryRun(), url: req.url });
      return NextResponse.json({ emails_sent: 2, considered: 5, note: "secret text never copied" });
    });
    const res = await gatedCron("invoice-dunning", handler)(call());
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ a: true, b: false, dry: false, url: "http://localhost/api/cron/invoice-dunning" }]);
    expect(h.recordRun).toHaveBeenCalledWith("invoice-dunning", [A], "Ran: emails_sent 2, considered 5");
  });

  it("practice run for B: the route gets its own ?dry=1 and the would-send list is recorded", async () => {
    h.cronTenants.mockResolvedValueOnce({ on: [], dry: [B] });
    const handler = vi.fn(async (req: NextRequest) => {
      expect(new URL(req.url).searchParams.get("dry")).toBe("1");
      expect(isCronDryRun()).toBe(true);
      expect(cronTenantAllowed(B)).toBe(true);
      expect(cronTenantAllowed(A)).toBe(false);
      noteWouldSend({ tenantId: B, to: "c@example.in", channel: "email", kind: "dunning" });
      return NextResponse.json({ emails_sent: 0 });
    });
    await gatedCron("invoice-dunning", handler)(call());
    expect(handler).toHaveBeenCalledTimes(1);
    const line = h.recordRun.mock.calls[0][2] as string;
    expect(line).toContain("Practice run");
    expect(line).toContain("would send 1 message to c@example.in");
    expect(line).toContain("nothing was sent");
  });

  it("ON for A and practice for B: a live pass for A, then a practice pass for B", async () => {
    h.cronTenants.mockResolvedValueOnce({ on: [A], dry: [B] });
    const modes: string[] = [];
    const handler = vi.fn(async () => { modes.push(currentCronRun()!.mode); return NextResponse.json({}); });
    await gatedCron("invoice-dunning", handler)(call());
    expect(modes).toEqual(["live", "dry"]);
  });

  it("a job with no practice mode does nothing in practice run", async () => {
    h.cronTenants.mockResolvedValueOnce({ on: [], dry: [A] });
    const handler = vi.fn(async () => NextResponse.json({}));
    const res = await gatedCron("register-domains", handler)(call());
    expect(handler).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ skipped: "dry_run_unavailable" });
    expect(h.recordRun).toHaveBeenCalledWith("register-domains", [A], expect.stringContaining("not available"));
  });

  it("platform job: only the platform company's switch counts", async () => {
    h.cronTenants.mockResolvedValueOnce({ on: [A], dry: [] });   // some other company turned it on
    const handler = vi.fn(async () => NextResponse.json({}));
    const res = await gatedCron("demo-reset", handler)(call());
    expect(handler).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ skipped: "off" });
  });

  it("platform job ON for the platform company covers every company", async () => {
    process.env.BUY_PAGE_TENANT_ID = A;
    h.cronTenants.mockResolvedValueOnce({ on: [A], dry: [] });
    const handler = vi.fn(async () => { expect(cronTenantAllowed(B)).toBe(true); return NextResponse.json({}); });
    await gatedCron("demo-reset", handler)(call());
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("backup is ON by default (SAFETY_JOBS_DEFAULT_ON)", () => {
  it("no row → the backup runs, and an explicit ON row is written before the run is stamped", async () => {
    h.readJobRow.mockResolvedValueOnce(null);
    const handler = vi.fn(async () => NextResponse.json({ ok: 3 }));
    await gatedCron("backup", handler)(call());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(h.ensureDefaultOnRow).toHaveBeenCalledWith(expect.any(String), "backup");
    expect(h.cronTenants).not.toHaveBeenCalled();
    expect(h.ensureDefaultOnRow.mock.invocationCallOrder[0]).toBeLessThan(h.recordRun.mock.invocationCallOrder[0]);
  });

  it("the switch cannot be read → the backup still runs", async () => {
    h.readJobRow.mockResolvedValueOnce(undefined);
    const handler = vi.fn(async () => NextResponse.json({}));
    await gatedCron("backup", handler)(call());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("the owner turned it off → skipped", async () => {
    h.readJobRow.mockResolvedValueOnce({ job: "backup", enabled: false, dry_run: false });
    const handler = vi.fn(async () => NextResponse.json({}));
    const res = await gatedCron("backup", handler)(call());
    expect(handler).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ skipped: "off" });
    expect(h.ensureDefaultOnRow).not.toHaveBeenCalled();
  });

  it("outside a cron, nothing is filtered", () => {
    expect(cronTenantAllowed(A)).toBe(true);
    expect(isCronDryRun()).toBe(false);
  });
});

describe("summarise", () => {
  it("copies numbers only, never strings", () => {
    expect(summarise(200, { sent: 3, to: "x@y", errors: ["boom"] }, "live", [])).toBe("Ran: sent 3, errors 1");
  });
  it("a failed run says so", () => {
    expect(summarise(500, { error: "x" }, "live", [])).toBe("Failed (500)");
  });
});
