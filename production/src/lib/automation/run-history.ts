/**
 * R-1104: the run history of the scheduled jobs (public.automation_job_runs) — the pure parts,
 * shared by the gate that writes it, the API that reads it and the /automation page.
 */

export type RunStatus = "ok" | "failed" | "skipped" | "practice";
export type RunTrigger = "schedule" | "manual" | "retry";

export interface JobRun {
  id: string;
  job: string;
  ranAt: string;
  status: RunStatus;
  trigger: RunTrigger;
  result: string | null;
  startedBy: string | null;
  retryOf: string | null;
}

/**
 * A run's status from the line the gate writes (cron-gate.ts summarise / gatedCron):
 *   "Failed …" → failed · "Skipped …" / "Practice run is not available …" → skipped ·
 *   "Practice run …" → practice · anything else ("Ran …") → ok.
 */
export function runStatus(result: string): RunStatus {
  const r = result.trim();
  if (/^Failed\b/i.test(r)) return "failed";
  if (/^Skipped\b/i.test(r) || /^Practice run is not available/i.test(r)) return "skipped";
  if (/^Practice run\b/i.test(r)) return "practice";
  return "ok";
}

/**
 * Should this run go into the history? A SCHEDULED pass of a job that is off writes nothing
 * (gmail-inbox is called every minute — 1,440 "Skipped" rows a day would bury the real runs);
 * last_result on automation_jobs still says it was skipped. A person pressing Run now on a job
 * that is off is told so, and that IS recorded.
 */
export function shouldRecordRun(result: string, trigger: RunTrigger): boolean {
  return !(trigger === "schedule" && /^Skipped — turned off/.test(result.trim()));
}

/** Runs grouped by job, newest first, at most `perJob` each. */
export function groupRuns(runs: readonly JobRun[], perJob = 10): Record<string, JobRun[]> {
  const out: Record<string, JobRun[]> = {};
  const sorted = [...runs].sort((a, b) => b.ranAt.localeCompare(a.ranAt));
  for (const r of sorted) {
    const list = (out[r.job] ??= []);
    if (list.length < perJob) list.push(r);
  }
  return out;
}

/**
 * May this run be retried? Only a FAILED run, and only while it is the newest run of its job:
 * once a later run has happened (scheduled or by hand), retrying the old failure would only run
 * the job again for no reason — press Run now for that.
 */
export function canRetry(run: Pick<JobRun, "id" | "status">, newestRunId: string | null | undefined): boolean {
  return run.status === "failed" && run.id === newestRunId;
}

/** How one run was started — a fact, not a button, so it never reads as one. */
export const TRIGGER_LABEL: Record<RunTrigger, string> = {
  schedule: "On schedule",
  manual: "Started with Run now",
  retry: "Retry of a failed run",
};

export const STATUS_LABEL: Record<RunStatus, { label: string; kind: "success" | "danger" | "muted" | "warning" }> = {
  ok:       { label: "Done",         kind: "success" },
  failed:   { label: "Failed",       kind: "danger" },
  skipped:  { label: "Not run",      kind: "muted" },
  practice: { label: "Practice run", kind: "warning" },
};
