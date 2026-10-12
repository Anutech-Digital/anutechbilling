/**
 * R-897: the scheduled-job switches on /automation.
 *
 *   GET  owner + manager — every job (from lib/automation/jobs.ts) with its state, last run
 *        and last result. A job with no row is OFF.
 *   PUT  owner only — { job, enabled, dryRun }. Written through the SIGNED-IN client and the
 *        set_automation_job() RPC, so the database's own owner-only policy decides, and the
 *        trigger stamps who changed it and writes the change to activity_log.
 */
import { z } from "zod";
import { withRoute, RouteError } from "@/lib/api/with-route";
import { readTenantJobs } from "@/lib/automation/gate.server";
import {
  AUTOMATION_JOBS, CUSTOMER_MESSAGES, CUSTOMER_MESSAGES_SPEC, isAutomationSwitch, platformTenantId, stateOf,
  type AutomationJob,
} from "@/lib/automation/jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withRoute(
  {
    route: "api/automation/jobs",
    roles: ["owner", "manager"],
    roleHint: "Only the owner or a manager can see the scheduled jobs. Ask your owner.",
  },
  async ({ tenantId, role }) => {
    const rows = await readTenantJobs(tenantId);
    if (!rows) throw new RouteError(503, "Could not read the job switches. Nothing has changed — reload to try again.");
    const byJob = new Map(rows.map((r) => [r.job, r]));
    const isPlatform = tenantId === platformTenantId();
    const row = (job: string) => {
      const r = byJob.get(job);
      return {
        state: stateOf(r, job),
        lastRunAt: r?.last_run_at ?? null,
        lastResult: r?.last_result ?? null,
        changedAt: r?.changed_at ?? null,
      };
    };
    return {
      canEdit: role === "owner",
      customerMessages: { id: CUSTOMER_MESSAGES, ...CUSTOMER_MESSAGES_SPEC, ...row(CUSTOMER_MESSAGES) },
      jobs: (Object.keys(AUTOMATION_JOBS) as AutomationJob[])
        /* Platform jobs (backup, demo reset, error digest) belong to the platform company
           only; another company's switch for them would control nothing. */
        .filter((id) => AUTOMATION_JOBS[id].scope === "tenant" || isPlatform)
        .map((id) => ({ id, ...AUTOMATION_JOBS[id], ...row(id) })),
    };
  },
);

const PutInput = z.object({
  job: z.string().refine(isAutomationSwitch, "Unknown automation."),
  enabled: z.boolean(),
  dryRun: z.boolean().default(false),
});

export const PUT = withRoute(
  {
    route: "api/automation/jobs",
    input: PutInput,
    roles: ["owner"],
    roleHint: "Only the owner can turn automations on or off. Ask your owner to change it.",
  },
  async ({ supabase, input }) => {
    if (input.dryRun && input.job !== CUSTOMER_MESSAGES) {
      const spec = AUTOMATION_JOBS[input.job as AutomationJob];
      if (!spec.dryRun) throw new RouteError(400, `"${spec.label}" has no practice run. Turn it on or leave it off.`);
    }
    if (input.dryRun && input.job === CUSTOMER_MESSAGES) {
      throw new RouteError(400, "Customer messages are either on or off.");
    }
    /* Not in the generated types (see gate.server.ts) — the RPC is called by name. */
    const rpc = supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
    const { error } = await rpc.call(supabase, "set_automation_job", {
      p_job: input.job, p_enabled: input.enabled, p_dry_run: input.dryRun,
    });
    if (error) {
      if (error.code === "42501") throw new RouteError(403, "Only the owner can turn automations on or off. Ask your owner to change it.", error.message);
      throw new RouteError(500, "Could not save that switch. Nothing changed — try again.", error.message);
    }
    return { job: input.job, state: stateOf({ enabled: input.enabled, dry_run: input.dryRun }) };
  },
);
