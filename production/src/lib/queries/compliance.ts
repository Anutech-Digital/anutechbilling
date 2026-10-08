/**
 * Compliance filing log queries — records which statutory obligations the tenant
 * has marked filed. The obligation catalog itself is code (lib/compliance/
 * obligations.ts); this only stores the tenant's filed/period state.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { createClient } from "@/lib/supabase/client";
import type { ComplianceLogRow } from "@/lib/supabase/database.types";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { tdsLookbackFrom, tdsMonthsFrom } from "@/lib/compliance/tds-not-applicable";

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

/** Roles whose RLS lets them read salary_payments (migration 20260930175000). */
const SALARY_READ_ROLES = new Set(["owner", "manager", "accountant"]);

/**
 * R-181 — months (YYYY-MM) in the recent past in which ANY TDS was deducted:
 * salary TDS (salary_payments.period) + vendor TDS (expenses.expense_date).
 * The Compliance page uses it to show "Deposit TDS" as N/A for a month with none.
 *
 * Returns `null` (→ every month counts, the old behaviour) whenever the answer
 * cannot be trusted: a role that RLS hides salary_payments from would read
 * "no salary TDS" and silently hide a real deposit deadline.
 */
export function useTdsMonths(today: Date) {
  const me = useCurrentUser();
  const role = me.data?.role ?? null;
  const from = tdsLookbackFrom(today);
  return useQuery({
    queryKey: ["compliance_tds_months", from, role],
    enabled: me.isSuccess,
    queryFn: async (): Promise<Set<string> | null> => {
      if (!role || !SALARY_READ_ROLES.has(role)) return null;
      const supabase = createClient();
      const [sal, exp] = await Promise.all([
        supabase.from("salary_payments").select("period, tds").gte("period", from.slice(0, 7)).gt("tds", 0),
        supabase.from("expenses").select("expense_date, tds_amount").gte("expense_date", from).gt("tds_amount", 0),
      ]);
      if (sal.error) throw sal.error;
      if (exp.error) throw exp.error;
      return tdsMonthsFrom(sal.data, exp.data);
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
    onError: (err) => toastError(err),
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
    onError: (err) => toastError(err),
  });
}
