/**
 * Quality Score data (R-263) — the slim rows lib/quality/score.ts turns into numbers.
 *
 * "This workspace" reads through the browser client, so RLS keeps it to the signed-in
 * tenant. "All workspaces" is the platform owner's view and goes through
 * /api/quality/platform (service role, behind the founder allowlist — the same gate as
 * /api/admin/feedback/platform).
 *
 * feedback.checked_at arrived in migration 20261006130000; a database without it yet must
 * still show every other number, so that column is read on its own and its absence is
 * reported (checkedAvailable: false) rather than failing the page.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { QUALITY_FEEDBACK_COLUMNS, mergeQualityInput, type QualityFeedbackRow, type QualityInput } from "./score";

const FEEDBACK_LIMIT = 5000;

export function useQualityInput(tenantId: string | null) {
  return useQuery({
    queryKey: ["quality", "mine", tenantId],
    enabled: Boolean(tenantId),
    staleTime: 60_000,
    queryFn: async (): Promise<QualityInput> => {
      const supabase = createClient();
      const [tenantQ, invoiceQ, feedbackQ, checkedQ] = await Promise.all([
        supabase.from("tenants").select("id, created_at").eq("id", tenantId as string),
        /* Only the first invoice matters for "signup → first invoice". */
        supabase.from("invoices").select("tenant_id, created_at").order("created_at", { ascending: true }).limit(1),
        supabase.from("feedback").select(QUALITY_FEEDBACK_COLUMNS).order("created_at", { ascending: false }).limit(FEEDBACK_LIMIT),
        supabase.from("feedback").select("id, checked_at").not("checked_at", "is", null).limit(FEEDBACK_LIMIT),
      ]);
      if (tenantQ.error) throw tenantQ.error;
      if (invoiceQ.error) throw invoiceQ.error;
      if (feedbackQ.error) throw feedbackQ.error;
      return mergeQualityInput(
        tenantQ.data ?? [],
        invoiceQ.data ?? [],
        (feedbackQ.data ?? []) as unknown as Omit<QualityFeedbackRow, "checked_at">[],
        checkedQ.error ? null : (checkedQ.data ?? []) as { id: string; checked_at: string | null }[],
      );
    },
  });
}

export function usePlatformQualityInput(enabled: boolean) {
  return useQuery({
    queryKey: ["quality", "platform"],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<QualityInput> => {
      const res = await fetch("/api/quality/platform");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error([json.error, json.nextStep].filter(Boolean).join(" ") || "Could not load");
      return json as QualityInput;
    },
  });
}
