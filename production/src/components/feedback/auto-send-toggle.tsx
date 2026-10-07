/**
 * "Auto-send new reports to AI" — the workspace switch for R-357, for the Bug Reports page.
 *
 * ON (default): a new report goes to the AI queue as soon as it is triaged, no Run AI Auto-Fix
 * press. Only the owner can flip it; everyone else sees the state. Before migration
 * 20261007110000_feedback_agent_claim.sql it shows ON and a save explains why it was not stored.
 *
 * Mount: <FeedbackAutoSendToggle /> under the page heading in src/app/(app)/admin/feedback/page.tsx.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { toastError } from "@/lib/errors/toast-error";

interface AutoSendState {
  on: boolean;
  canEdit: boolean;
  ready: boolean;
}

const KEY = ["feedback", "auto-send"] as const;

export function FeedbackAutoSendToggle() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<AutoSendState> => {
      const res = await fetch("/api/feedback/auto-send");
      const json = (await res.json().catch(() => ({}))) as Partial<AutoSendState> & { error?: string };
      if (!res.ok) throw new Error(json.error || "Could not read the setting.");
      return { on: json.on !== false, canEdit: Boolean(json.canEdit), ready: Boolean(json.ready) };
    },
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: async (on: boolean) => {
      const res = await fetch("/api/feedback/auto-send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Could not save the setting.");
      return on;
    },
    onSuccess: (on) => {
      qc.setQueryData<AutoSendState>(KEY, (old) => (old ? { ...old, on } : old));
      toast.success(on ? "New reports go to the AI on their own" : "New reports wait for Run AI Auto-Fix");
    },
    onError: (err) => toastError(err),
  });

  if (isLoading || !data) return null;
  const id = "feedback-auto-send";

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-hairline bg-paper px-3 py-2">
      <Switch
        id={id}
        checked={data.on}
        disabled={!data.canEdit || save.isPending}
        onCheckedChange={(v) => save.mutate(v)}
        aria-label="Auto-send new reports to AI"
      />
      <label htmlFor={id} className="text-sm font-medium text-ink">
        Auto-send new reports to AI
      </label>
      <span className="text-2xs text-ink-3">
        {data.on
          ? "New reports go to the AI queue as soon as they are triaged."
          : "New reports wait in Open until someone presses Run AI Auto-Fix."}
        {!data.canEdit && " Only the owner can change this."}
      </span>
    </div>
  );
}
