/**
 * JunkAIReview — AI-assisted spam triage for the Leads "Junk" view.
 *
 * The heuristic (looksLikeJunk) flags obvious suspects; this lets the operator
 * ask the AI to actually DECIDE across the review pile — each verdict comes with
 * a confidence and a short reason. Nothing is marked automatically: the AI
 * proposes, the operator confirms with one tap (marking is reversible via
 * "Restore"). Degrades to the deterministic heuristic when no Gemini key is set.
 */
"use client";

import * as React from "react";
import { GeminiCard } from "@/components/shared/gemini-card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useClassifyJunk, useSetLeadJunk, type JunkAiVerdict } from "@/lib/queries/leads";
import type { Lead } from "@/lib/supabase/database.types";
import { cn } from "@/lib/utils";

export function JunkAIReview({ leads }: { leads: Lead[] }) {
  const classify = useClassifyJunk();
  const setJunk = useSetLeadJunk();
  const [verdicts, setVerdicts] = React.useState<Record<string, JunkAiVerdict>>({});
  const [mode, setMode] = React.useState<"gemini" | "stub" | null>(null);

  const byId = React.useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads]);
  const reviewIds = React.useMemo(() => leads.map((l) => l.id), [leads]);

  async function runReview() {
    if (reviewIds.length === 0) return;
    const res = await classify.mutateAsync(reviewIds).catch(() => null);
    if (!res) return;
    setMode(res.mode);
    setVerdicts(Object.fromEntries(res.verdicts.map((v) => [v.id, v])));
  }

  // Leads the AI (or heuristic) flagged as junk and that aren't marked junk yet.
  const flagged = React.useMemo(
    () => Object.values(verdicts).filter((v) => v.suspect && !byId.get(v.id)?.is_junk),
    [verdicts, byId],
  );

  async function markAllFlagged() {
    const ids = flagged.map((v) => v.id);
    if (ids.length === 0) return;
    await setJunk.mutateAsync({ ids, isJunk: true }).catch(() => {});
  }

  const hasResults = Object.keys(verdicts).length > 0;

  return (
    <GeminiCard
      title="AI junk review"
      actions={
        <>
          <Button
            size="sm"
            variant="primary"
            icon="sparkles"
            disabled={classify.isPending || reviewIds.length === 0}
            onClick={runReview}
          >
            {classify.isPending ? "Reviewing…" : hasResults ? "Re-run AI review" : `Review ${reviewIds.length} with AI`}
          </Button>
          {flagged.length > 0 && (
            <Button size="sm" icon="alert" disabled={setJunk.isPending} onClick={markAllFlagged}>
              Mark all {flagged.length} junk
            </Button>
          )}
        </>
      }
    >
      {!hasResults ? (
        <>
          <b className="text-ink">{reviewIds.length} lead{reviewIds.length === 1 ? "" : "s"} to review.</b>{" "}
          AI will flag likely spam / fake / test enquiries and explain why. Nothing is marked until you confirm.
        </>
      ) : (
        <div className="space-y-2">
          {mode === "stub" && (
            <p className="text-xs text-ink-3">
              Using the built-in heuristic. Add a Gemini key in Settings → Integrations → AI for smarter detection.
            </p>
          )}
          <ul className="space-y-1.5">
            {[...Object.values(verdicts)]
              .sort((a, b) => Number(b.suspect) - Number(a.suspect) || b.confidence - a.confidence)
              .map((v) => {
                const lead = byId.get(v.id);
                if (!lead) return null;
                const isJunk = lead.is_junk;
                return (
                  <li
                    key={v.id}
                    className="flex items-center gap-3 rounded-lg border border-hairline bg-paper px-3 py-2"
                  >
                    <span
                      className={cn(
                        "shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                        v.suspect ? "bg-rose-soft text-rose" : "bg-emerald-soft text-emerald",
                      )}
                    >
                      {v.suspect ? "Junk" : "Genuine"}
                      {v.suspect && v.confidence > 0 && <span className="tabular-nums opacity-80">{Math.round(v.confidence * 100)}%</span>}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-ink truncate">
                        {lead.company || lead.contact_name || "Unnamed lead"}
                      </span>
                      <span className="block text-[11px] text-ink-3 truncate">{v.reason}</span>
                    </span>
                    {isJunk ? (
                      <button
                        type="button"
                        onClick={() => setJunk.mutate({ ids: [v.id], isJunk: false })}
                        className="shrink-0 text-xs font-medium text-ink-2 hover:text-ink inline-flex items-center gap-1"
                      >
                        <Icon name="check_circle" size={13} /> Restore
                      </button>
                    ) : v.suspect ? (
                      <button
                        type="button"
                        onClick={() => setJunk.mutate({ ids: [v.id], isJunk: true })}
                        className="shrink-0 text-xs font-medium text-rose hover:text-rose/80 inline-flex items-center gap-1"
                      >
                        <Icon name="alert" size={13} /> Mark junk
                      </button>
                    ) : null}
                  </li>
                );
              })}
          </ul>
        </div>
      )}
    </GeminiCard>
  );
}
