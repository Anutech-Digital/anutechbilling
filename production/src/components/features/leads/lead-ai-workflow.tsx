"use client";
/**
 * R-2042 — AI Lead Workflow D: the "Run AI Lead Workflow" button + live step chips, in the lead
 * drawer's pinned header.
 *
 * Press → POST /api/leads/[id]/ai-workflow (R-2039). That request runs the whole thing (website
 * read, qualify, 2-line pitch as a DRAFT — nothing is sent) and can take a minute, so while it is
 * open — or while GET says the latest run has no finished_at — the chips poll GET every
 * AI_POLL_MS and move on as the runner writes each step. Polling stops by itself once the run has
 * finished. Same query key as the Email tab's draft card (LEAD_AI_RUN_KEY), so the draft appears
 * there the moment it is ready.
 *
 * Chips (outcome-chips look, but read-only — they report, they do not act):
 *   Fetching data → AI qualified (or Not qualified + the AI's reasons) → Draft ready → Sent →
 *   Call scheduled → Call done.
 * A refused or failed run shows what went wrong AND the next step (CLAUDE.md §24) — the route's
 * { error, detail }, or the stored run's error + next_step after a reload.
 *
 * Not primary: the drawer's next-step button is the view's one primary action (R-2265). Hidden
 * when the route refuses the caller's role (403) — the route refuses the POST anyway.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  LEAD_AI_RUN_KEY, fetchLeadAiRun, LeadAiForbiddenError, type LeadAiRunView,
} from "@/components/features/leads/lead-ai-draft-card";
import { LEAD_AI_STATUSES_KEY } from "@/components/features/leads/lead-ai-status";

/** How often an open run is re-read. */
export const AI_POLL_MS = 2_000;

export type AiChipState = "done" | "current" | "failed" | "todo";
export interface AiChip { id: string; label: string; state: AiChipState }

const CHIPS = [
  { id: "fetching", label: "Fetching data" },
  { id: "qualified", label: "AI qualified" },
  { id: "draft_ready", label: "Draft ready" },
  { id: "sent", label: "Sent" },
  { id: "call_scheduled", label: "Call scheduled" },
  { id: "call_done", label: "Call done" },
] as const;

/* How many chips a step has completed (the step names what has been DONE, except "fetching",
   which is written when the run starts and covers the website read + the qualify call). */
const DONE_UPTO: Record<string, number> = {
  fetching: 0, qualified: 2, unqualified: 1, draft_ready: 3, sent: 4, call_scheduled: 5, call_done: 6,
};

/** The chips for a run. `pressed` = a POST is open (a run is starting even before GET shows it). */
export function aiChipStates(run: LeadAiRunView | null | undefined, pressed: boolean): AiChip[] {
  const open = pressed || (!!run && !run.finished_at);
  if (!run || (pressed && run.finished_at)) {
    /* Nothing yet, or an old finished run while a new one starts. */
    return CHIPS.map((c, i) => ({ ...c, state: open && i === 0 ? "current" : "todo" }));
  }
  if (run.step === "unqualified") {
    return [
      { ...CHIPS[0], state: "done" },
      { id: "unqualified", label: "Not qualified", state: "failed" },
    ];
  }
  if (run.step === "failed") {
    /* Where it stopped: after a qualify verdict the pitch failed; before one, the qualify did. */
    const at = run.qualify_result?.verdict === "qualified" ? 2 : 1;
    return CHIPS.map((c, i) => ({ ...c, state: i < at ? "done" : i === at ? "failed" : "todo" }));
  }
  const done = DONE_UPTO[run.step] ?? 0;
  return CHIPS.map((c, i) => ({
    ...c,
    state: i < done ? "done" : i === done && open ? "current" : "todo",
  }));
}

const CHIP_TONE: Record<AiChipState, string> = {
  done: "border-emerald/40 bg-emerald-soft text-emerald",
  current: "border-amber/50 bg-amber-soft/60 text-amber-ink",
  failed: "border-rose/50 bg-rose-soft/60 text-rose-ink",
  todo: "border-hairline text-ink-3",
};
const CHIP_ICON: Record<AiChipState, string> = { done: "check", current: "clock", failed: "x", todo: "" };

interface PostError { error: string; detail?: string }

export function LeadAiWorkflow({ leadId, onOpenDraft }: {
  leadId: string;
  /** Opens the Email tab, where R-2040's draft card shows the draft. */
  onOpenDraft?: () => void;
}) {
  const qc = useQueryClient();
  const [postError, setPostError] = React.useState<PostError | null>(null);

  const run = useMutation({
    mutationFn: async (): Promise<{ ok: true; run: LeadAiRunView | null } | { ok: false; err: PostError; run: LeadAiRunView | null }> => {
      let res: Response;
      try {
        res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/ai-workflow`, { method: "POST" });
      } catch {
        return { ok: false, run: null, err: { error: "Could not reach the server.", detail: "Check your internet connection and press Run AI Lead Workflow again." } };
      }
      const json = await res.json().catch(() => ({})) as { run?: LeadAiRunView; error?: string; detail?: string };
      if (!res.ok) {
        return { ok: false, run: json.run ?? null, err: { error: json.error || `The AI Lead Workflow did not start (${res.status}).`, detail: json.detail || "Try again in a minute." } };
      }
      return { ok: true, run: json.run ?? null };
    },
    onMutate: () => setPostError(null),
    onSuccess: (out) => {
      if (out.run) qc.setQueryData(LEAD_AI_RUN_KEY(leadId), out.run);
      if (!out.ok) setPostError(out.err);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: LEAD_AI_RUN_KEY(leadId) });
      void qc.invalidateQueries({ queryKey: LEAD_AI_STATUSES_KEY });
    },
  });
  const pressed = run.isPending;

  const { data: latest, error: readError, isPending: firstRead } = useQuery({
    queryKey: LEAD_AI_RUN_KEY(leadId),
    queryFn: () => fetchLeadAiRun(leadId),
    staleTime: 30_000,
    retry: (n, e) => !(e instanceof LeadAiForbiddenError) && n < 2,
    /* Poll only while a run is open: the POST is still going, or the latest run is unfinished. */
    refetchInterval: (q) => (pressed || (q.state.data && !q.state.data.finished_at) ? AI_POLL_MS : false),
  });

  /* Wait for the first read: a role the route refuses (403) never sees the button flash. */
  if (firstRead || readError instanceof LeadAiForbiddenError) return null;

  const chips = aiChipStates(latest, pressed);
  const running = pressed || (!!latest && !latest.finished_at);
  const shownRun = pressed ? null : latest;
  const failure: PostError | null = postError
    ?? (shownRun?.step === "failed" && shownRun.error ? { error: shownRun.error, detail: shownRun.next_step ?? undefined } : null);
  const reasons = shownRun?.step === "unqualified" ? shownRun.qualify_result?.reasons ?? [] : [];
  const showChips = running || !!latest;

  return (
    <section aria-label="AI Lead Workflow" className="mt-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon="sparkles"
          disabled={running}
          aria-busy={running || undefined}
          onClick={() => run.mutate()}
          title="Reads the lead's website, asks the AI whether it fits, and writes a 2-line email draft. Nothing is sent."
        >
          {running ? "Running AI Lead Workflow…" : "Run AI Lead Workflow"}
        </Button>
        {!running && shownRun?.step === "draft_ready" && onOpenDraft && (
          <Button size="sm" variant="link" icon="mail" onClick={onOpenDraft}>Open the draft in the Email tab</Button>
        )}
      </div>

      {showChips && (
        <ol aria-label="AI Lead Workflow steps" className="flex flex-wrap items-center gap-1">
          {chips.map((c) => (
            <li
              key={c.id}
              aria-label={c.label}
              aria-current={c.state === "current" ? "step" : undefined}
              data-state={c.state}
              className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-semibold", CHIP_TONE[c.state])}
            >
              {CHIP_ICON[c.state] && <Icon name={CHIP_ICON[c.state]} size={11} />}
              {c.label}
            </li>
          ))}
        </ol>
      )}

      {reasons.length > 0 && (
        <div className="text-xs text-ink-2">
          <span className="font-semibold">Why not qualified:</span>
          <ul className="ml-4 list-disc">
            {reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
          {shownRun?.next_step && <p className="text-ink-3">{shownRun.next_step}</p>}
        </div>
      )}

      {failure && (
        <div role="alert" className="rounded-md border border-rose/40 bg-rose-soft/40 px-2.5 py-1.5 text-xs text-rose-ink">
          <span className="font-semibold">{failure.error}</span>
          {failure.detail && <> <span>Next step: {failure.detail}</span></>}
        </div>
      )}
    </section>
  );
}
