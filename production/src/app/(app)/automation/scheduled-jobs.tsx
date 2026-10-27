/**
 * R-897: the scheduled-job switches — what the app runs on its own, each one OFF until the
 * owner turns it on. Owner changes; a manager sees it read-only; nobody else gets the panel.
 *
 * R-1104 (23 Oct 2026): each job also shows WHEN it runs (plain English, from the same
 * schedule Cloud Scheduler is given), its run history (last 10 runs: result, time, who
 * started it), "Run now" and "Retry" on a failed run. Both buttons go through
 * POST /api/automation/jobs/run — owner or manager, the job's own cron route on the server,
 * this company only, the same switch (a job that is off does not run).
 */
"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { loadErrorBody } from "@/components/shared/load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";
import { useConfirm } from "@/components/providers/confirm-provider";
import { STATUS_LABEL, TRIGGER_LABEL, canRetry, type JobRun } from "@/lib/automation/run-history";

type State = "off" | "dry_run" | "on";

interface JobRow {
  id: string;
  label: string;
  what: string;
  customerFacing?: boolean;
  dryRun?: boolean;
  state: State;
  lastRunAt: string | null;
  lastResult: string | null;
  /** R-1104 — jobs only, not the customer-messages switch. */
  schedule?: string;
  runs?: JobRun[];
}

interface JobsResponse {
  ok: true;
  canEdit: boolean;
  canRun: boolean;
  historyReadable: boolean;
  customerMessages: JobRow;
  jobs: JobRow[];
}

interface RunResponse {
  outcome: "ran" | "failed" | "off" | "no_practice";
  run: JobRun | null;
}

const STATE_BADGE: Record<State, { label: string; kind: "success" | "warning" | "muted" }> = {
  on:      { label: "On",           kind: "success" },
  dry_run: { label: "Practice run", kind: "warning" },
  off:     { label: "Off",          kind: "muted" },
};

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? fallback);
  return json as T;
}

export function ScheduledJobs() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [openHistory, setOpenHistory] = React.useState<Record<string, boolean>>({});

  const q = useQuery({
    queryKey: ["automation-jobs"],
    queryFn: async () => {
      const res = await fetch("/api/automation/jobs", { cache: "no-store" });
      if (res.status === 403) return null;           // not owner / manager: no panel
      return readJson<JobsResponse>(res, "Could not load");
    },
  });

  const save = useMutation({
    mutationFn: async (body: { job: string; enabled: boolean; dryRun: boolean }) => {
      const res = await fetch("/api/automation/jobs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return readJson<unknown>(res, "Could not save");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automation-jobs"] }),
    onError: (e) => toast.error((e as Error).message),
  });

  /* R-1104: Run now / Retry. One job at a time from this page; the server refuses a second
     press anyway (409), this only keeps the button honest while it waits. */
  const run = useMutation({
    mutationFn: async (v: { job: JobRow; retryOf?: string }) => {
      const res = await fetch("/api/automation/jobs/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job: v.job.id, retryOf: v.retryOf }),
      });
      return readJson<RunResponse>(res, "Could not start the job");
    },
    onSuccess: (r, v) => {
      const name = `"${v.job.label}"`;
      const line = r.run?.result ?? undefined;
      if (r.outcome === "ran") toast.success(`${name} ran.`, { description: line });
      else if (r.outcome === "off") toast.info(`${name} is off, so it did not run.`, { description: "Turn it on first. Run now follows the switch." });
      else if (r.outcome === "no_practice") toast.info(`${name} has no practice run, so nothing was done.`, { description: "Turn it fully on to run it." });
      else toast.error(`${name} failed.`, { description: `${line ?? "See the run history."} Press Retry to run it again.` });
      setOpenHistory((o) => ({ ...o, [v.job.id]: true }));
      void qc.invalidateQueries({ queryKey: ["automation-jobs"] });
    },
    onError: (e, v) => {
      toast.error(`Could not run "${v.job.label}"`, { description: (e as Error).message });
      void qc.invalidateQueries({ queryKey: ["automation-jobs"] });
    },
  });

  async function setJob(row: JobRow, enabled: boolean, dryRun: boolean) {
    if (enabled && !dryRun && row.customerFacing) {
      const ok = await confirm({
        title: `Turn on "${row.label}"?`,
        body: "From its next run this job works on real customers. Customer messages also need their own switch on.",
        confirmLabel: "Turn on",
      });
      if (!ok) return;
    }
    save.mutate({ job: row.id, enabled, dryRun });
  }

  async function runNow(row: JobRow, retryOf?: string) {
    if (row.state === "on" && row.customerFacing) {
      const ok = await confirm({
        title: retryOf ? `Retry "${row.label}" now?` : `Run "${row.label}" now?`,
        body: "It runs exactly like its scheduled run and works on real customers. Anything it already did is not done twice.",
        confirmLabel: retryOf ? "Retry" : "Run now",
      });
      if (!ok) return;
    }
    run.mutate({ job: row, retryOf });
  }

  /* R-1922: a refused quote email's "Turn on customer messages" lands on
     /automation#customer-messages. The card renders only after this query, after the browser
     has already tried the #hash — so scroll to it once the data is here. */
  const loaded = Boolean(q.data);
  React.useEffect(() => {
    if (!loaded || typeof window === "undefined" || window.location.hash !== "#customer-messages") return;
    document.getElementById("customer-messages")?.scrollIntoView({ block: "center" });
  }, [loaded]);

  if (q.isLoading) return <Card className="mb-6 p-4"><Skeleton className="h-40 w-full" /></Card>;
  if (q.error) {
    return (
      <Card className="mb-6 p-4">
        <p className="text-sm text-rose">
          Could not read the scheduled jobs. {loadErrorBody(q.error)} Nothing has changed.
        </p>
      </Card>
    );
  }
  const data = q.data;
  if (!data) return null;
  const canEdit = data.canEdit && !save.isPending;
  const cm = data.customerMessages;

  return (
    <section className="mb-6" aria-labelledby="scheduled-jobs-title">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="scheduled-jobs-title" className="font-serif text-xl text-ink">Scheduled jobs</h2>
        <span className="text-2xs text-ink-3">Every job starts off, except the nightly backup. Only the owner can change them.</span>
      </div>

      <Card id="customer-messages" className="mb-3 scroll-mt-24 border-amber/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-serif text-lg text-ink">{cm.label}</h3>
              <Badge kind={STATE_BADGE[cm.state].kind} dot>{STATE_BADGE[cm.state].label}</Badge>
            </div>
            <p className="mt-1 text-xs leading-snug text-ink-3">{cm.what}</p>
          </div>
          <Switch
            checked={cm.state === "on"}
            disabled={!canEdit}
            onCheckedChange={(on) => void setJob({ ...cm, customerFacing: true }, on, false)}
            aria-label="Customer messages on or off"
          />
        </div>
      </Card>

      <Card className="divide-y divide-hairline p-0">
        {data.jobs.map((j) => {
          const runs = j.runs ?? [];
          const historyOpen = Boolean(openHistory[j.id]);
          const running = run.isPending && run.variables?.job.id === j.id;
          const historyId = `job-history-${j.id}`;
          return (
            <div key={j.id} className="p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-ink">{j.label}</span>
                    <Badge kind={STATE_BADGE[j.state].kind} dot>{STATE_BADGE[j.state].label}</Badge>
                    {j.customerFacing && <Badge kind="muted">Reaches customers</Badge>}
                  </div>
                  <p className="mt-0.5 text-2xs text-ink-3">{j.what}</p>
                  {j.schedule && <p className="mt-0.5 text-2xs text-ink-2">Runs: {j.schedule}</p>}
                  <p className="mt-0.5 text-2xs text-ink-3">
                    {j.lastRunAt ? `Last run ${formatDate(j.lastRunAt, "long")}: ${j.lastResult ?? "—"}` : "Has not run yet"}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-3">
                  {data.canRun && (
                    <Button
                      size="sm"
                      icon="play"
                      loading={running}
                      disabled={run.isPending || j.state === "off"}
                      title={j.state === "off" ? "This job is off. Turn it on first; Run now follows the switch." : undefined}
                      onClick={() => void runNow(j)}
                    >
                      Run now
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={historyOpen ? "chevron_up" : "chevron_down"}
                    aria-expanded={historyOpen}
                    aria-controls={historyId}
                    onClick={() => setOpenHistory((o) => ({ ...o, [j.id]: !historyOpen }))}
                  >
                    {historyOpen ? "Hide history" : "Show history"}
                  </Button>
                  {j.dryRun && (
                    <label className="flex min-h-11 items-center gap-2 text-xs text-ink-2">
                      <Switch
                        checked={j.state === "dry_run"}
                        disabled={!canEdit || j.state === "off"}
                        onCheckedChange={(dry) => void setJob(j, true, dry)}
                        aria-label={`Practice run for ${j.label}`}
                      />
                      Practice run
                    </label>
                  )}
                  <Switch
                    checked={j.state !== "off"}
                    disabled={!canEdit}
                    onCheckedChange={(on) => void setJob(j, on, false)}
                    aria-label={`${j.label} on or off`}
                  />
                </div>
              </div>

              {historyOpen && (
                <div id={historyId} className="mt-2 rounded-md border border-hairline bg-paper-2/40">
                  {!data.historyReadable ? (
                    /* A read failure is not "no runs" — the two mean opposite things. */
                    <p className="p-3 text-xs text-rose">Could not read the run history. This does not mean it never ran — reload to try again.</p>
                  ) : runs.length === 0 ? (
                    <p className="p-3 text-xs text-ink-3">No runs recorded yet. Runs from 23 Oct 2026 onward appear here.</p>
                  ) : (
                    <ul className="divide-y divide-hairline">
                      {runs.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge kind={STATUS_LABEL[r.status].kind} dot>{STATUS_LABEL[r.status].label}</Badge>
                              <span className="font-mono text-2xs text-ink-2">{formatDate(r.ranAt, "long")}</span>
                              <span className="text-2xs text-ink-3">{TRIGGER_LABEL[r.trigger]}</span>
                            </div>
                            {r.result && <p className="mt-0.5 break-words text-2xs text-ink-2">{r.result}</p>}
                          </div>
                          {data.canRun && canRetry(r, runs[0]?.id) && (
                            <Button
                              size="sm"
                              variant="outline"
                              icon="refresh"
                              loading={running && run.variables?.retryOf === r.id}
                              disabled={run.isPending || j.state === "off"}
                              title={j.state === "off" ? "This job is off. Turn it on first; Retry follows the switch." : undefined}
                              onClick={() => void runNow(j, r.id)}
                            >
                              Retry
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </Card>

      <p className="mt-2 text-2xs text-ink-3">
        Practice run: the job works out what it would do and records it under Last run, and sends or changes nothing.
        Run now and Retry follow the same switch: a job that is off does not run, and one in practice run only practises.
        Alerts are snoozed in Google Cloud (Pardeep).
      </p>
      {!data.canEdit && (
        <p className="mt-1 text-2xs text-ink-3">You can see these switches but not change them. Ask the owner.</p>
      )}
    </section>
  );
}
