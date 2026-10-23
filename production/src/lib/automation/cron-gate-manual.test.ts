/**
 * R-1104: "Run now" / "Retry" go through the same gate as the schedule — for the caller's
 * company only, following that company's own switch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  cronTenants: vi.fn(async () => ({ on: [] as string[], dry: [] as string[] })),
  recordRun: vi.fn(async (..._a: unknown[]) => {}),
  readJobRow: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  ensureDefaultOnRow: vi.fn(async (..._a: unknown[]) => {}),
  automationState: vi.fn(async (..._a: unknown[]): Promise<string> => "off"),
}));
vi.mock("@/lib/automation/gate.server", () => ({
  cronTenants: h.cronTenants, recordRun: h.recordRun, readJobRow: h.readJobRow,
  ensureDefaultOnRow: h.ensureDefaultOnRow, automationState: h.automationState,
}));

import { gatedCron, cronTenantAllowed, isCronDryRun } from "./cron-gate";
import { runManually, currentManualRun } from "./manual-run";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const PLATFORM = "fbb976f1-9090-4f10-9726-0901bd144e42";
const USER = "cccccccc-0000-4000-8000-000000000003";
const call = (job = "invoice-dunning", bearer = "s") =>
  new NextRequest(`http://localhost/api/cron/${job}`, { headers: { authorization: `Bearer ${bearer}` } });
const asOwnerOfA = <T>(fn: () => Promise<T>, trigger: "manual" | "retry" = "manual") =>
  runManually({ tenantId: A, userId: USER, trigger, retryOf: trigger === "retry" ? "run-1" : null }, fn);

beforeEach(() => {
  process.env.CRON_SECRET = "s";
  delete process.env.BUY_PAGE_TENANT_ID;
  vi.clearAllMocks();
});

describe("manual run (Run now / Retry)", () => {
  it("ON for A: one live pass for A only — B is never touched, even if B has it on too", async () => {
    h.automationState.mockResolvedValueOnce("on");
    h.cronTenants.mockResolvedValueOnce({ on: [A, B], dry: [] });
    const seen: unknown[] = [];
    const handler = vi.fn(async () => {
      seen.push({ a: cronTenantAllowed(A), b: cronTenantAllowed(B), dry: isCronDryRun(), manual: currentManualRun()?.trigger });
      return NextResponse.json({ emails_sent: 1 });
    });
    const res = await asOwnerOfA(() => gatedCron("invoice-dunning", handler)(call()));
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ a: true, b: false, dry: false, manual: "manual" }]);
    expect(h.cronTenants).not.toHaveBeenCalled();
    expect(h.automationState).toHaveBeenCalledWith(A, "invoice-dunning");
    expect(h.recordRun).toHaveBeenCalledWith("invoice-dunning", [A], "Ran: emails_sent 1");
  });

  it("OFF for A: nothing runs, and the skip is recorded for A", async () => {
    h.automationState.mockResolvedValueOnce("off");
    const handler = vi.fn(async () => NextResponse.json({}));
    const res = await asOwnerOfA(() => gatedCron("invoice-dunning", handler)(call()));
    expect(await res.json()).toMatchObject({ skipped: "off" });
    expect(handler).not.toHaveBeenCalled();
    expect(h.recordRun).toHaveBeenCalledWith("invoice-dunning", [A], "Skipped — turned off");
  });

  it("practice run for A: the route gets its dry flag", async () => {
    h.automationState.mockResolvedValueOnce("dry_run");
    const handler = vi.fn(async (req: NextRequest) => {
      expect(new URL(req.url).searchParams.get("dry")).toBe("1");
      expect(isCronDryRun()).toBe(true);
      return NextResponse.json({ emails_sent: 0 });
    });
    await asOwnerOfA(() => gatedCron("invoice-dunning", handler)(call()), "retry");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(String(h.recordRun.mock.calls[0][2])).toContain("Practice run");
  });

  it("a job with no practice mode in practice run does nothing and says so", async () => {
    h.automationState.mockResolvedValueOnce("dry_run");
    const handler = vi.fn(async () => NextResponse.json({}));
    const res = await asOwnerOfA(() => gatedCron("cold-calls", handler)(call("cold-calls")));
    expect(await res.json()).toMatchObject({ skipped: "dry_run_unavailable" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("a platform job asked for by another company is refused", async () => {
    const handler = vi.fn(async () => NextResponse.json({}));
    const res = await asOwnerOfA(() => gatedCron("backup", handler)(call("backup")));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("the platform company can run its backup (default ON, no row yet)", async () => {
    h.readJobRow.mockResolvedValueOnce(null);
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    await runManually({ tenantId: PLATFORM, userId: USER, trigger: "manual", retryOf: null },
      () => gatedCron("backup", handler)(call("backup")));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(h.ensureDefaultOnRow).toHaveBeenCalledWith(PLATFORM, "backup");
  });

  it("without the cron secret even a manual run is refused before the route", async () => {
    const handler = vi.fn(async () => NextResponse.json({}));
    const res = await asOwnerOfA(() => gatedCron("invoice-dunning", handler)(call("invoice-dunning", "wrong")));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("outside runManually there is no manual run (a request cannot claim one)", () => {
    expect(currentManualRun()).toBe(null);
  });
});
