"use client";
/**
 * R-2040 — AI Lead Workflow B: the AI's email draft, on the lead.
 *
 * R-2039's runner writes a 2-line pitch + subject on the lead's latest `lead_ai_runs` row and
 * stops at `draft_ready` — nothing is sent. This card shows that draft and opens the lead email
 * composer pre-filled with it ("Review & send"); the person may edit it and presses
 * "Approve & send", which posts to the SAME /api/leads/[id]/email route as every lead email
 * (its permission, sender routing and send-refusal rules apply unchanged). That route marks the
 * run `sent` itself, after a real send — this card only shows the result. No auto-send anywhere.
 *
 * Reads GET /api/leads/[id]/ai-workflow (the caller's own client, RLS) under the query key
 * LEAD_AI_RUN_KEY(leadId), which the composer refreshes after a send.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

export const LEAD_AI_RUN_KEY = (leadId: string) => ["lead-ai-run", leadId] as const;

/** The fields of R-2039's run that this card reads. */
export interface LeadAiRunView {
  id: string;
  step: string;
  pitch: string | null;
  draft_subject: string | null;
  updated_at: string;
}

export interface AiDraft { runId: string; subject: string; body: string }

export async function fetchLeadAiRun(leadId: string): Promise<LeadAiRunView | null> {
  const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/ai-workflow`);
  if (!res.ok) return null;
  const json = await res.json() as { run?: LeadAiRunView | null };
  return json.run ?? null;
}

export function LeadAiDraftCard({ leadId, hasEmail, onReview }: {
  leadId: string;
  /** The composer needs an address to show; without one the card says where to add it. */
  hasEmail: boolean;
  onReview: (draft: AiDraft) => void;
}) {
  const { data: run } = useQuery({
    queryKey: LEAD_AI_RUN_KEY(leadId),
    queryFn: () => fetchLeadAiRun(leadId),
    staleTime: 30_000,
  });

  if (!run || !run.pitch || (run.step !== "draft_ready" && run.step !== "sent")) return null;
  const subject = run.draft_subject ?? "";
  const sent = run.step === "sent";

  return (
    <section aria-label="AI email draft" className="mb-3 rounded-md border border-hairline bg-paper-2 p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-ink-3">AI email draft</span>
        {sent
          ? <Badge kind="success" size="sm" dot>Sent</Badge>
          : <Badge kind="warning" size="sm" dot>Not sent</Badge>}
        {sent && <span className="text-xs text-ink-3">{formatDate(run.updated_at)}</span>}
      </div>
      {subject && <div className="text-sm font-medium text-ink">{subject}</div>}
      <p className="mt-1 whitespace-pre-line text-sm text-ink-2">{run.pitch}</p>
      {!sent && (
        <div className="mt-2.5 flex items-center gap-2">
          {hasEmail ? (
            <Button variant="primary" size="sm" icon="send" onClick={() => onReview({ runId: run.id, subject, body: run.pitch! })}>
              Review &amp; send
            </Button>
          ) : (
            <span className="text-xs text-ink-3">This lead has no email address. Add one with Edit, then you can send the draft.</span>
          )}
          <span className="text-xs text-ink-3">Nothing is sent until you approve it.</span>
        </div>
      )}
    </section>
  );
}
