"use client";
/**
 * R-366 — the AI pieces of the "All workspaces" list on /admin/feedback (platform owner only):
 *   - the R-356 status line on a platform row ("AI worker has it", "Fixed by AI · R-xxx"),
 *   - "Send to AI" on an open row, and "Send all open to AI" above the list.
 *
 * Both buttons call /api/admin/feedback/platform/dispatch, which re-checks the platform
 * allowlist server-side; the page draws them only for the platform owner.
 */
import * as React from "react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDate } from "@/lib/utils";
import { parseFixedNote } from "@/lib/feedback/fixed-note";
import { canQueue, dispatchSummary, type PlatformDispatchBody } from "@/lib/feedback/platform-dispatch";
import type { PlatformFeedbackRow } from "@/lib/queries/feedback";
import { isUrgent } from "@/lib/feedback/urgent";
import { UrgentStrip, urgentAtOf } from "./urgent-toggle";

type AiRow = Pick<PlatformFeedbackRow, "id" | "status" | "dispatched_at" | "resolution_note" | "resolved_at">;

/** The worker's claim (R-357 agent_card) once that migration is applied; else from the note. */
function cardFor(row: AiRow): string | null {
  const claimed = (row as { agent_card?: string | null }).agent_card ?? null;
  return claimed ?? parseFixedNote(row.resolution_note).card;
}

export function PlatformAiStatus({ row }: { row: AiRow }) {
  if (row.status === "agent_queued") {
    const card = cardFor(row);
    /* R-397: "⚡ Urgent · AI worker has it · R-xxx". */
    if (isUrgent(row)) return <UrgentStrip card={card} urgentAt={urgentAtOf(row)} className="inline-block text-2xs" />;
    return (
      <p data-testid="platform-ai-queued" className="mt-1 text-2xs text-ink-2 bg-paper-2 border border-hairline rounded-md px-2 py-1 inline-block">
        🤖 AI worker has it{card ? <> · card <b className="font-mono">{card}</b></> : null}
        {row.dispatched_at ? <> · queued {formatDate(row.dispatched_at, "relative")}</> : null}
      </p>
    );
  }
  if (row.status === "fixed" && row.resolution_note) {
    const n = parseFixedNote(row.resolution_note);
    return (
      <p data-testid="platform-ai-fixed" className="mt-1 text-2xs text-ink-2 bg-emerald-soft/40 border border-emerald/30 rounded-md px-2 py-1 inline-flex flex-wrap gap-x-1.5">
        <span className="font-semibold text-emerald-ink">🤖 Fixed by AI</span>
        {n.card && <><span className="text-ink-4">·</span><span className="font-mono font-semibold text-ink">{n.card}</span></>}
        {n.commit && <><span className="text-ink-4">·</span><span className="font-mono text-ink-3">{n.commit}</span></>}
        <span className="text-ink-4">·</span>
        <span className="min-w-0 break-words">{n.text}</span>
        {row.resolved_at && <><span className="text-ink-4">·</span><span className="text-ink-3">{formatDate(row.resolved_at, "relative")}</span></>}
      </p>
    );
  }
  return null;
}

interface DispatchResult { queued: string[]; skipped: string[] }

export function useSendPlatformToAi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: PlatformDispatchBody): Promise<DispatchResult> => {
      const res = await fetch("/api/admin/feedback/platform/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error([json.error, json.nextStep].filter(Boolean).join(" ") || "Could not send to the AI.");
      return { queued: json.queued ?? [], skipped: json.skipped ?? [] };
    },
    onSuccess: (r) => {
      toast.success(dispatchSummary(r.queued.length, r.skipped.length), {
        description: r.queued.length > 0 ? "It becomes a card on the work board within the hour." : undefined,
      });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not send to the AI."),
    /* The platform list, and this workspace's own list/counts (a row may be ours too). */
    onSettled: () => qc.invalidateQueries({ queryKey: ["feedback"] }),
  });
}

export function SendToAiButton({ row }: { row: AiRow }) {
  const send = useSendPlatformToAi();
  if (!canQueue(row)) return null;
  return (
    <button
      type="button"
      disabled={send.isPending}
      onClick={() => send.mutate({ id: row.id })}
      className="mt-2 mr-2 rounded border border-primary/40 bg-primary/5 px-2 py-0.5 text-2xs font-medium text-primary hover:bg-primary/10 disabled:opacity-60"
    >
      {send.isPending ? "Sending…" : "🤖 Send to AI"}
    </button>
  );
}

export function SendAllOpenButton({ rows }: { rows: AiRow[] }) {
  const send = useSendPlatformToAi();
  const open = rows.filter(canQueue).length;
  if (open === 0) return null;
  return (
    <button
      type="button"
      disabled={send.isPending}
      onClick={() => send.mutate({ all: true })}
      className="rounded border border-primary/40 bg-primary/5 px-2 py-0.5 text-2xs font-medium text-primary hover:bg-primary/10 disabled:opacity-60"
    >
      {send.isPending ? "Sending…" : `🤖 Send all open to AI (${open})`}
    </button>
  );
}
