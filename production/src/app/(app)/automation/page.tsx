/**
 * Automation — what the app does on its own, and the switch that stops it.
 *
 * ─── WHY THIS PAGE EXISTS ───────────────────────────────────────────────────
 * Until 23 Aug 2026 five crons emailed customers unattended and there was no way to stop
 * any of them from inside this app: the only brake was disabling a Cloud Scheduler job in a
 * Google console. The dial and the log shipped first; this is the part a person can reach.
 *
 * ─── THE ORDER ON THE PAGE IS THE ORDER OF URGENCY ──────────────────────────
 * 1. WAITING ON YOU — held actions. Each one is a real customer whose next step needs a
 *    human decision. Nothing else on this screen is time-sensitive; this is.
 * 2. THE SWITCH. Big, first among the controls, and reachable without scrolling — somebody
 *    opening this page in a hurry is usually looking for exactly this.
 * 3. The per-action dial.
 * 4. The log.
 *
 * A settings page would normally lead with settings. This one leads with the queue, because
 * the common visit is "what happened while I was away" and the rare visit is "change a
 * setting" — and the rare visit is the one that survives having to scroll.
 */
"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { cn, formatDate } from "@/lib/utils";
import { useConfirm } from "@/components/providers/confirm-provider";
import { killSwitchFor, needsConfirmation } from "@/lib/ai/autonomy";
import { isLessonProposal, stillWaiting } from "@/lib/ai/public-chat-lessons";
import { ScheduledJobs } from "./scheduled-jobs";

type Mode = "off" | "hold" | "auto";

interface ActionRow {
  id: string;
  label: string;
  supports: Mode[];
  default: Mode;
  mode: Mode;
  isDefault: boolean;
}

interface AutonomyResponse {
  killSwitch: boolean;
  canEdit: boolean;
  actions: ActionRow[];
}

interface LogRow {
  id: number;
  created_at: string;
  action: string;
  outcome: "did" | "held" | "skipped" | "failed";
  reason: string;
  mode: Mode;
  entity: string | null;
  entity_id: string | null;
  facts: Record<string, unknown>;
}

const MODE_COPY: Record<Mode, { label: string; hint: string }> = {
  auto: { label: "Automatic", hint: "Runs without asking you." },
  hold: { label: "Prepare only", hint: "Gets it ready and waits for you to send." },
  off:  { label: "Off", hint: "Does not run at all." },
};

const OUTCOME_COPY: Record<LogRow["outcome"], { label: string; kind: "success" | "warning" | "muted" | "danger" }> = {
  /* `skipped` is muted and `failed` is danger, and keeping them apart is the point — a
     working kill switch would otherwise read as an outage on this very screen. */
  did:     { label: "Done",        kind: "success" },
  held:    { label: "Waiting",     kind: "warning" },
  skipped: { label: "Not run",     kind: "muted"   },
  failed:  { label: "Failed",      kind: "danger"  },
};

async function getJson<T>(url: string): Promise<T> {
  const res  = await fetch(url, { cache: "no-store" });
  const json = await res.json();
  if (!res.ok) throw new Error((json as { error?: string }).error ?? "Request failed");
  return json as T;
}

export default function AutomationPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();

  const policy = useQuery({
    queryKey: ["ai-autonomy"],
    queryFn:  () => getJson<AutonomyResponse>("/api/ai/autonomy"),
  });

  const log = useQuery({
    queryKey: ["ai-action-log"],
    queryFn:  () => getJson<{ rows: LogRow[] }>("/api/ai/action-log?limit=100"),
  });

  const save = useMutation({
    mutationFn: async (body: { killSwitch?: boolean; action?: string; mode?: Mode }) => {
      const res  = await fetch("/api/ai/autonomy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error((json as { error?: string }).error ?? "Could not save");
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai-autonomy"] });
      qc.invalidateQueries({ queryKey: ["ai-action-log"] });
    },
    /* The server's sentence, not a generic one. Its 403 already explains that only an owner
       or manager can change this and says to ask one of them — rewriting that here would
       lose the next step. */
    onError: (e) => toast.error((e as Error).message),
  });

  /* R-727: website-chat lessons are proposals until a person decides; a decided one (its
     approve/discard row is in the log) is no longer waiting. */
  const allRows = log.data?.rows ?? [];
  const held = stillWaiting(allRows.filter((r) => r.outcome === "held"), allRows);
  const canEdit = policy.data?.canEdit ?? false;

  const decideLesson = useMutation({
    mutationFn: async (body: { id: number; decision: "approve" | "discard" }) => {
      const res  = await fetch("/api/ai/action-log/lesson", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error((json as { error?: string }).error ?? "Could not save your decision");
      return body;
    },
    onSuccess: (body) => {
      toast.success(body.decision === "approve"
        ? "Lesson approved — the website chat uses it from the next conversation."
        : "Lesson discarded — the website chat will not use it.");
      qc.invalidateQueries({ queryKey: ["ai-action-log"] });
    },
    /* The server's sentence already says what happened and what to do (§24); the action
       reloads the list, which is the next step it names. */
    onError: (e) => toast.error("Lesson not saved", {
      description: (e as Error).message,
      action: { label: "Reload list", onClick: () => qc.invalidateQueries({ queryKey: ["ai-action-log"] }) },
    }),
  });

  /**
   * `automationOn` is what the SWITCH says; `ai_kill_switch` is what the COLUMN stores.
   * They are opposites, and the first version of this function got both halves backwards —
   * found by clicking the switch in a browser, not by reading the code: turning automation
   * OFF popped a dialog reading "Turn automation back on?", and would then have written
   * killSwitch=false, leaving automation running while the operator believed they had
   * stopped it. A kill switch that silently does nothing is worse than none.
   *
   * The mapping now goes through `killSwitchFor` / `needsConfirmation` in lib/ai/autonomy.ts,
   * which exist so it is asserted in a test rather than re-derived here.
   */
  async function setAutomationOn(automationOn: boolean) {
    if (needsConfirmation(automationOn)) {
      const ok = await confirm({
        title: "Turn automation back on?",
        body:
          "Renewal reminders, invoice chasers and auto-quotes will start going to customers " +
          "again the next time each job runs. Anything held while it was off is not sent " +
          "retroactively — you send those yourself.",
        confirmLabel: "Turn automation on",
      });
      if (!ok) return;
    }
    save.mutate({ killSwitch: killSwitchFor(automationOn) });
  }

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 pb-20">
      <div className="mb-6">
        <p className="mb-0.5 text-xs font-medium uppercase tracking-widest text-ink-3">System</p>
        <h1 className="font-serif text-3xl text-ink">Automation</h1>
        <p className="mt-1 text-sm text-ink-3">
          What this app does on its own — and the switch that stops all of it.
        </p>
      </div>

      {/* ── 1. WAITING ON YOU ─────────────────────────────────────────────────
          First, because each row is a customer whose next step needs a person. Rendered
          only when there is something: an empty "nothing waiting" panel at the top of every
          visit trains people to scroll past this spot. */}
      {held.length > 0 && (
        <Card className="mb-6 border-amber/40 bg-amber-soft/30 p-4">
          <div className="mb-3 flex items-center gap-2">
            <Icon name="info" size={16} className="text-amber-ink" />
            <h2 className="font-serif text-lg text-ink">
              {held.length === 1 ? "1 thing is waiting on you" : `${held.length} things are waiting on you`}
            </h2>
          </div>
          <ul className="space-y-2">
            {held.map((r) => (
              <li key={r.id} className="rounded-md border border-hairline bg-paper p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{r.action}</span>
                  <span className="font-mono text-2xs text-ink-3">
                    {formatDate(r.created_at)}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-snug text-ink-2">{r.reason}</p>
                <FactList facts={r.facts} />
                {isLessonProposal(r) && (
                  /* R-727: a lesson the website chat wants to learn. It reaches the chat only
                     after Use lesson. */
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-2xs text-ink-3">
                      The website chat wants to learn this. It is used only after you approve it.
                    </span>
                    {canEdit ? (
                      <>
                        <Button
                          size="sm"
                          disabled={decideLesson.isPending}
                          onClick={() => decideLesson.mutate({ id: r.id, decision: "approve" })}
                        >
                          Use lesson
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={decideLesson.isPending}
                          onClick={() => decideLesson.mutate({ id: r.id, decision: "discard" })}
                        >
                          Discard
                        </Button>
                      </>
                    ) : (
                      <span className="text-2xs text-ink-3">An owner or a manager can approve or discard it.</span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ScheduledJobs />

      {/* ── 2. THE SWITCH ─────────────────────────────────────────────────── */}
      <Card className="mb-6 p-4">
        {policy.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : policy.error ? (
          <p className="text-sm text-rose">
            Could not read the automation settings — {(policy.error as Error).message}. Nothing
            has changed; reload to try again.
          </p>
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h2 className="font-serif text-lg text-ink">
                {policy.data?.killSwitch ? "Automation is OFF" : "Automation is on"}
              </h2>
              <p className="mt-1 text-xs leading-snug text-ink-3">
                {policy.data?.killSwitch
                  ? "Nothing is being sent to customers automatically. Reminders, chasers and " +
                    "auto-quotes are all held. Your own alerts still reach you."
                  : "Renewal reminders, invoice chasers, trial reminders, greetings and auto-quotes " +
                    "can go out without you. Turn this off to stop all of them at once."}
              </p>
              {/* Stated plainly, because it is the question somebody will have the moment
                  they flip it back. */}
              <p className="mt-1.5 text-2xs text-ink-3">
                Turning it off never stops your own alerts — a switch that silenced those
                would hide the thing you flipped it to look at.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs font-semibold text-ink-2">
                {policy.data?.killSwitch ? "Off" : "On"}
              </span>
              <Switch
                checked={!policy.data?.killSwitch}
                disabled={!canEdit || save.isPending}
                onCheckedChange={(on) => void setAutomationOn(on)}
                aria-label="Automation on or off for this workspace"
              />
            </div>
          </div>
        )}
        {!canEdit && !policy.isLoading && (
          <p className="mt-3 border-t border-hairline pt-3 text-2xs text-ink-3">
            You can see these settings but not change them. Ask an owner or a manager.
          </p>
        )}
      </Card>

      {/* ── 3. THE DIAL ───────────────────────────────────────────────────── */}
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-serif text-xl text-ink">What it may do</h2>
        <span className="text-2xs text-ink-3">
          {policy.data?.killSwitch ? "All paused by the switch above" : ""}
        </span>
      </div>
      <Card className="mb-6 divide-y divide-hairline p-0">
        {policy.isLoading
          ? <div className="p-4"><Skeleton className="h-40 w-full" /></div>
          : (policy.data?.actions ?? []).map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-ink">{a.label}</span>
                  {a.isDefault && (
                    /* Says nobody chose this. Without it a default reads as a decision, and
                       the operator cannot tell what they have actually configured. */
                    <Badge kind="muted">default</Badge>
                  )}
                </div>
                <p className="mt-0.5 text-2xs text-ink-3">{MODE_COPY[a.mode].hint}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                {(["off", "hold", "auto"] as Mode[])
                  .filter((m) => a.supports.includes(m))
                  .map((m) => (
                    <button
                      key={m}
                      type="button"
                      disabled={!canEdit || save.isPending}
                      onClick={() => save.mutate({ action: a.id, mode: m })}
                      aria-current={a.mode === m ? "true" : undefined}
                      className={cn(
                        "min-h-11 rounded-md border px-3 text-xs font-semibold transition-colors",
                        a.mode === m
                          ? "border-amber bg-amber-soft/60 text-amber-ink"
                          : "border-hairline bg-paper text-ink-2 hover:bg-paper-2",
                        (!canEdit || save.isPending) && "cursor-not-allowed opacity-60",
                      )}
                    >
                      {MODE_COPY[m].label}
                    </button>
                  ))}
              </div>
            </div>
          ))}
      </Card>

      {/* ── 4. THE LOG ────────────────────────────────────────────────────── */}
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-serif text-xl text-ink">What it did</h2>
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => void log.refetch()}>
          Refresh
        </Button>
      </div>
      <Card className="p-0">
        {log.isLoading ? (
          <div className="p-4"><Skeleton className="h-32 w-full" /></div>
        ) : log.error ? (
          /* A read failure is NOT an empty log. "The app did nothing" and "we could not find
             out what the app did" look identical and mean opposite things. */
          <p className="p-4 text-sm text-rose">
            Could not read the log — {(log.error as Error).message}. This does not mean nothing
            happened; it means we could not find out.
          </p>
        ) : (log.data?.rows ?? []).length === 0 ? (
          <EmptyState
            title="Nothing recorded yet"
            description="Every automatic action will appear here with the reason it ran — or the reason it did not."
          />
        ) : (
          <ul className="divide-y divide-hairline">
            {(log.data?.rows ?? []).map((r) => (
              <li key={r.id} className="p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge kind={OUTCOME_COPY[r.outcome].kind} dot>
                      {OUTCOME_COPY[r.outcome].label}
                    </Badge>
                    <span className="font-mono text-xs text-ink-2">{r.action}</span>
                    {r.entity && r.entity_id && (
                      <span className="font-mono text-2xs text-ink-3">
                        {r.entity} {r.entity_id}
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-2xs text-ink-3">
                    {formatDate(r.created_at)}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-snug text-ink-2">{r.reason}</p>
                <FactList facts={r.facts} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * The facts the decision rested on.
 *
 * Shown rather than hidden behind a disclosure, because this is the whole reason the log is
 * worth more than a list of events: when something went out wrong, the first question is
 * what the app thought it knew. Small by construction — the builder refuses nested values
 * and truncates long strings — so there is no risk of a wall.
 */
function FactList({ facts }: { facts: Record<string, unknown> }) {
  const entries = Object.entries(facts ?? {}).filter(([k]) => !k.startsWith("_"));
  if (entries.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
      {entries.map(([k, v]) => (
        <span key={k} className="font-mono text-3xs text-ink-3">
          <span className="text-ink-4">{k}</span> {String(v)}
        </span>
      ))}
    </div>
  );
}
