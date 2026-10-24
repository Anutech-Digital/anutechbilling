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
import { fetchAllRows } from "@/lib/ops/fetch-all";
import type { ComplianceLogRow } from "@/lib/supabase/database.types";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { tdsLookbackFrom, tdsMonthsFrom } from "@/lib/compliance/tds-not-applicable";
import { fetchCogsBillTds } from "@/lib/queries/cogs-bill-tds";

const KEY = ["compliance_log"] as const;

export function useComplianceLog() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<ComplianceLogRow[]> => {
      const supabase = createClient();
      // R-1582: paged — ~20 filings a month pass 1000 rows in four years.
      return (await fetchAllRows((from, to) => supabase
        .from("compliance_log")
        .select("*")
        .order("due_date", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to))) as ComplianceLogRow[];
    },
  });
}

/** Roles whose RLS lets them read salary_payments (migration 20260930175000). */
const SALARY_READ_ROLES = new Set(["owner", "manager", "accountant"]);

/**
 * R-181 — months (YYYY-MM) in the recent past in which ANY TDS was deducted:
 * salary TDS (salary_payments.period) + vendor TDS (expenses.expense_date) + partner
 * commission TDS (referral_commissions.earned_date, R-1580).
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
      return fetchTdsMonths(createClient(), from);
    },
  });
}

/**
 * The months with any TDS since `from`. R-1582: both reads page past the gateway's 1000-row
 * cap — a month whose TDS rows sat past the cap showed "Deposit TDS" as N/A.
 */
export async function fetchTdsMonths(supabase: ReturnType<typeof createClient>, from: string): Promise<Set<string>> {
  const [sal, exp, comm] = await Promise.all([
    fetchAllRows((f, t) => supabase.from("salary_payments").select("period, tds")
      .gte("period", from.slice(0, 7)).gt("tds", 0)
      .order("id", { ascending: true }).range(f, t)),
    fetchAllRows((f, t) => supabase.from("expenses").select("expense_date, tds_amount")
      .gte("expense_date", from).gt("tds_amount", 0)
      .order("id", { ascending: true }).range(f, t)),
    /* R-1580: TDS on partner commissions (194H) — a month with only that TDS still has a deposit. */
    fetchAllRows((f, t) => supabase.from("referral_commissions").select("earned_date, tds_amount, status")
      .gte("earned_date", from).gt("tds_amount", 0).neq("status", "cancelled")
      .order("id", { ascending: true }).range(f, t)),
  ]);
  /* R-1891: 194Q TDS on goods bills paid from the bank — a deposit in the month it was deducted. */
  const goods = await fetchCogsBillTds(supabase, { from });
  return tdsMonthsFrom(sal, [...exp, ...goods.map((g) => ({ expense_date: g.tds_on, tds_amount: g.tds_amount }))], comm);
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
