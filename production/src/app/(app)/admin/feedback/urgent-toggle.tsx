"use client";
/**
 * R-397 — the "⚡ Urgent" toggle and the urgent strip on /admin/feedback (this workspace's
 * cards and the platform owner's All-workspaces rows).
 *
 * The button calls POST /api/feedback/urgent, which re-checks who may press it (owner or
 * manager of the report's own workspace, or the platform owner). The page draws it only
 * when the row carries the urgent_at column (migration applied) — see lib/feedback/urgent.
 */
import * as React from "react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDate } from "@/lib/utils";
import { isUrgent, showUrgentToggle, urgentLabel, urgentToast, type UrgentBody, type UrgentRowLike } from "@/lib/feedback/urgent";

export function useMarkUrgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: UrgentBody): Promise<{ urgent: boolean; queued: boolean }> => {
      const res = await fetch("/api/feedback/urgent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error([json.error, json.nextStep].filter(Boolean).join(" ") || "Could not change Urgent.");
      return { urgent: Boolean(json.urgent), queued: Boolean(json.queued) };
    },
    onSuccess: (r) => {
      toast.success(urgentToast(r.urgent, r.queued), {
        description: r.urgent ? "The AI worker takes urgent reports before everything else." : undefined,
      });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not change Urgent."),
    onSettled: () => qc.invalidateQueries({ queryKey: ["feedback"] }),
  });
}

type UrgentRow = { id: string } & UrgentRowLike;

/** "⚡ Urgent" / "Not urgent" — hidden before the migration and on closed, non-urgent rows. */
export function UrgentToggle({ row, disabled = false, className = "" }: { row: UrgentRow; disabled?: boolean; className?: string }) {
  const mark = useMarkUrgent();
  if (!showUrgentToggle(row)) return null;
  const on = isUrgent(row);
  const title = on
    ? "Take Urgent back — it stays with the AI worker, in normal order"
    : row.status === "open"
      ? "Send it to the AI worker now, at the top of its queue"
      : "Move it to the top of the AI worker's queue";
  return (
    <button
      type="button"
      data-testid={`urgent-toggle-${row.id}`}
      aria-pressed={on}
      disabled={disabled || mark.isPending}
      onClick={() => mark.mutate({ id: row.id, urgent: !on })}
      title={title}
      className={
        "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60 " +
        (on ? "border-amber bg-amber-soft text-amber-ink hover:bg-amber-soft/70" : "border-hairline text-ink-2 hover:bg-paper-2") +
        (className ? ` ${className}` : "")
      }
    >
      {mark.isPending ? "Saving…" : on ? "⚡ Urgent ✓" : "⚡ Urgent"}
    </button>
  );
}

/** The queued strip of an urgent report: "⚡ Urgent · AI worker has it · R-xxx · marked 5 min ago". */
export function UrgentStrip({ card, urgentAt, className = "" }: { card: string | null; urgentAt: string | null; className?: string }) {
  return (
    <p data-testid="ai-urgent-strip" className={"mt-1 text-xs text-amber-ink bg-amber-soft border border-amber/40 rounded-md px-2 py-1 " + className}>
      <b>{urgentLabel(card)}</b>
      {urgentAt ? <span className="text-ink-3"> · marked {formatDate(urgentAt, "relative")}</span> : null}
    </p>
  );
}

/** urgent_at of a row whose type may not know the column yet. */
export function urgentAtOf(row: object): string | null {
  const v = (row as { urgent_at?: unknown }).urgent_at;
  return typeof v === "string" && v ? v : null;
}
