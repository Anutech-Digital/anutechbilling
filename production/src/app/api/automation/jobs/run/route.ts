/**
 * R-1104 — POST /api/automation/jobs/run { job, retryOf? }
 *
 * "Run now" (and "Retry" on a failed run) on /automation. Owner or manager only.
 *
 *   · The job runs through its OWN cron route, called in-process (lib/automation/
 *     cron-handlers.server.ts) inside runManually() — so the same gatedCron() decides:
 *     the company's switch (off → nothing runs), practice run, and this company only.
 *     Each job's own idempotency (renewal stages, dunning steps, invoice keys…) applies as on
 *     any scheduled run. The cron secret is added here, on the server; the browser never has it.
 *   · Retry: only the newest run of that job, and only when it failed (run-history canRetry).
 *   · A second press while it runs, or within a minute of a manual start, is refused (409).
 *   · The run lands in automation_job_runs with who pressed it (gate.server recordRun).
 */
import { z } from "zod";
import { NextRequest } from "next/server";
import { withRoute, RouteError } from "@/lib/api/with-route";
import { AUTOMATION_JOBS, isAutomationJob, platformTenantId, type AutomationJob } from "@/lib/automation/jobs";
import { readLatestRun, readRun } from "@/lib/automation/gate.server";
import { canRetry } from "@/lib/automation/run-history";
import { runManually } from "@/lib/automation/manual-run";
import { loadCronGet } from "@/lib/automation/cron-handlers.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** Jobs running right now on this server, by "<tenant>:<job>". */
const KEY = Symbol.for("resellersos.automation.runningNow");
const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
const running: Set<string> = (g[KEY] ??= new Set<string>());

const UNREADABLE = "Could not read the run history. Nothing was started — reload and try again.";

const Input = z.object({
  job: z.string().refine(isAutomationJob, "Unknown job."),
  retryOf: z.string().uuid().optional(),
});

export const POST = withRoute(
  {
    route: "api/automation/jobs/run",
    input: Input,
    roles: ["owner", "manager"],
    roleHint: "Only the owner or a manager can run a scheduled job. Ask your owner.",
  },
  async ({ req, input, tenantId, user }) => {
    const job = input.job as AutomationJob;
    const spec = AUTOMATION_JOBS[job];
    if (spec.scope === "platform" && tenantId !== platformTenantId()) {
      throw new RouteError(403, `"${spec.label}" runs for the whole app. Only the platform company can start it.`);
    }
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret) throw new RouteError(503, "Run now is not set up on this server (the scheduler key is missing). Ask Pardeep.");

    const latest = await readLatestRun(tenantId, job);
    if (latest === undefined) throw new RouteError(503, UNREADABLE);

    let retryOf: string | null = null;
    if (input.retryOf) {
      const run = await readRun(tenantId, input.retryOf);
      if (run === undefined) throw new RouteError(503, UNREADABLE);
      if (!run || run.job !== job) throw new RouteError(404, "That run was not found. Reload the page.");
      if (!canRetry(run, latest?.id)) {
        throw new RouteError(409, run.status !== "failed"
          ? "Only a failed run can be retried."
          : "A newer run has happened since this one failed. Press Run now if you want to run it again.");
      }
      retryOf = run.id;
    }

    const key = `${tenantId}:${job}`;
    if (running.has(key)) throw new RouteError(409, `"${spec.label}" is already running. Wait for it to finish, then reload.`);
    if (latest && latest.trigger !== "schedule" && Date.now() - Date.parse(latest.ranAt) < 60_000) {
      throw new RouteError(409, `"${spec.label}" was started less than a minute ago. Wait a minute before running it again.`);
    }

    const get = await loadCronGet(job);
    if (!get) throw new RouteError(500, `"${spec.label}" cannot be started from here.`);

    running.add(key);
    try {
      const cronReq = new NextRequest(new URL(`/api/cron/${job}`, req.nextUrl.origin), {
        method: "GET",
        headers: { authorization: `Bearer ${secret}` },
      });
      let res: Response;
      try {
        res = await runManually(
          { tenantId, userId: user.id, trigger: retryOf ? "retry" : "manual", retryOf },
          () => get(cronReq),
        );
      } catch (e) {
        throw new RouteError(502,
          `"${spec.label}" failed while running. It is in the history as Failed — press Retry, or ask Pardeep if it fails again.`,
          (e as Error).message);
      }
      let body: Record<string, unknown> = {};
      try { body = (await res.json()) as Record<string, unknown>; } catch { /* not JSON */ }
      const outcome = body.skipped === "off" ? "off"
        : body.skipped === "dry_run_unavailable" ? "no_practice"
        : res.ok ? "ran" : "failed";
      const run = await readLatestRun(tenantId, job);
      return { job, outcome, run: run ?? null };
    } finally {
      running.delete(key);
    }
  },
);
