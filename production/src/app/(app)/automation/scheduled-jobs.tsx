/**
 * R-897: the scheduled-job switches — what the app runs on its own, each one OFF until the
 * owner turns it on. Owner changes; a manager sees it read-only; nobody else gets the panel.
 */
"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";
import { useConfirm } from "@/components/providers/confirm-provider";

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
}

interface JobsResponse {
  ok: true;
  canEdit: boolean;
  customerMessages: JobRow;
  jobs: JobRow[];
}

const STATE_BADGE: Record<State, { label: string; kind: "success" | "warning" | "muted" }> = {
  on:      { label: "On",           kind: "success" },
  dry_run: { label: "Practice run", kind: "warning" },
  off:     { label: "Off",          kind: "muted" },
};

export function ScheduledJobs() {
  const qc = useQueryClient();
  const confirm = useConfirm();

  const q = useQuery({
    queryKey: ["automation-jobs"],
    queryFn: async () => {
      const res = await fetch("/api/automation/jobs", { cache: "no-store" });
      const json = await res.json();
      if (res.status === 403) return null;           // not owner / manager: no panel
      if (!res.ok) throw new Error((json as { error?: string }).error ?? "Could not load");
      return json as JobsResponse;
    },
  });

  const save = useMutation({
    mutationFn: async (body: { job: string; enabled: boolean; dryRun: boolean }) => {
      const res = await fetch("/api/automation/jobs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error((json as { error?: string }).error ?? "Could not save");
      return json;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automation-jobs"] }),
    onError: (e) => toast.error((e as Error).message),
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

  if (q.isLoading) return <Card className="mb-6 p-4"><Skeleton className="h-40 w-full" /></Card>;
  if (q.error) {
    return (
      <Card className="mb-6 p-4">
        <p className="text-sm text-rose">
          Could not read the scheduled jobs — {(q.error as Error).message}. Nothing has changed; reload to try again.
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

      <Card className="mb-3 border-amber/40 p-4">
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
        {data.jobs.map((j) => (
          <div key={j.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink">{j.label}</span>
                <Badge kind={STATE_BADGE[j.state].kind} dot>{STATE_BADGE[j.state].label}</Badge>
                {j.customerFacing && <Badge kind="muted">Reaches customers</Badge>}
              </div>
              <p className="mt-0.5 text-2xs text-ink-3">{j.what}</p>
              <p className="mt-0.5 text-2xs text-ink-3">
                {j.lastRunAt ? `Last run ${formatDate(j.lastRunAt)}: ${j.lastResult ?? "—"}` : "Has not run yet"}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-3">
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
        ))}
      </Card>

      <p className="mt-2 text-2xs text-ink-3">
        Practice run: the job works out what it would do and records it under Last run, and sends or changes nothing.
        Alerts are snoozed in Google Cloud (Pardeep).
      </p>
      {!data.canEdit && (
        <p className="mt-1 text-2xs text-ink-3">You can see these switches but not change them. Ask the owner.</p>
      )}
    </section>
  );
}
