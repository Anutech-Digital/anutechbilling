/**
 * Compliance filing log queries — records which statutory obligations the tenant
 * has marked filed. The obligation catalog itself is code (lib/compliance/
 * obligations.ts); this only stores the tenant's filed/period state.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import type { ComplianceLogRow } from "@/lib/supabase/database.types";

const KEY = ["compliance_log"] as const;

export function useComplianceLog() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<ComplianceLogRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("compliance_log")
        .select("*")
        .order("due_date", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ComplianceLogRow[];
    },
  });
}

/** filed-map keyed by `${obligation_key}|${period_key}` → filed_date. */
export function toFiledMap(rows: ComplianceLogRow[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  (rows ?? []).forEach((r) => m.set(`${r.obligation_key}|${r.period_key}`, r.filed_date));
  return m;
}

export function useMarkComplianceFiled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      obligation_key: string;
      period_key: string;
      period_label?: string | null;
      due_date?: string | null;
      filed_date: string;
      reference?: string | null;
      notes?: string | null;
    }) => {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      const { data: me } = await supabase
        .from("users").select("tenant_id").eq("id", auth!.user!.id).single();
      const { error } = await supabase
        .from("compliance_log")
        .upsert(
          {
            tenant_id: me!.tenant_id,
            obligation_key: input.obligation_key,
            period_key: input.period_key,
            period_label: input.period_label ?? null,
            due_date: input.due_date ?? null,
            filed_date: input.filed_date,
            reference: input.reference ?? null,
            notes: input.notes ?? null,
            created_by: auth!.user!.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "tenant_id,obligation_key,period_key" },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success("Marked filed");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

export function useUnmarkComplianceFiled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { obligation_key: string; period_key: string }) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("compliance_log")
        .delete()
        .eq("obligation_key", input.obligation_key)
        .eq("period_key", input.period_key);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success("Marked not filed");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}
