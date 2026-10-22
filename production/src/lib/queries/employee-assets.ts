/**
 * Company property issued to employees — reads/writes for lib/payroll/employee-assets.ts,
 * plus the facts the exit checklist needs (loans, unpaid payslips, documents).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import type { AssetKind, ReturnCondition } from "@/lib/payroll/employee-assets";

export interface EmployeeAsset {
  id: string;
  tenant_id: string;
  employee_id: string;
  kind: AssetKind;
  name: string;
  identifier: string | null;
  fixed_asset_id: string | null;
  issued_on: string;
  returned_on: string | null;
  return_condition: ReturnCondition | null;
  notes: string | null;
  created_at: string;
}

const KEY = ["employee-assets"] as const;

/** All issued items (one employee, or everyone when no id) — with the holder's name. */
export function useEmployeeAssets(employeeId?: string | null) {
  return useQuery({
    queryKey: [...KEY, employeeId ?? "all"],
    queryFn: async (): Promise<(EmployeeAsset & { employee_name: string })[]> => {
      const supabase = createClient();
      let q = supabase.from("employee_assets").select("*, employees!employee_assets_employee_id_fkey(name)").order("issued_on", { ascending: false });
      if (employeeId) q = q.eq("employee_id", employeeId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((r) => {
        const { employees, ...rest } = r as unknown as EmployeeAsset & { employees?: { name: string | null } | null };
        return { ...rest, employee_name: employees?.name ?? "—" };
      });
    },
    staleTime: 30_000,
  });
}

/** What the exit checklist needs beyond the items: outstanding advances, unpaid payslips, docs. */
export function useOffboardingFacts(employee: { id: string; name: string } | null) {
  return useQuery({
    queryKey: ["offboarding", employee?.id ?? "none"],
    enabled: !!employee,
    queryFn: async () => {
      const supabase = createClient();
      const name = employee!.name.trim();
      const [{ data: loans }, { data: sal }, { data: docs }] = await Promise.all([
        supabase.from("employee_loans").select("id, principal, status").ilike("employee_name", name.replace(/[%_\\]/g, (c) => "\\" + c)).neq("status", "closed"),
        supabase.from("salary_payments").select("period, net, paid_amount, paid_status").eq("employee_id", employee!.id).order("period", { ascending: false }),
        supabase.from("employee_documents").select("doc_type").eq("employee_id", employee!.id),
      ]);
      const loanIds = (loans ?? []).map((l) => l.id);
      const { data: repays } = loanIds.length ? await supabase.from("employee_loan_repayments").select("loan_id, amount").in("loan_id", loanIds) : { data: [] as { loan_id: string; amount: number }[] };
      const repaid = new Map<string, number>();
      for (const r of repays ?? []) repaid.set(r.loan_id, (repaid.get(r.loan_id) ?? 0) + (r.amount ?? 0));
      const loanOutstanding = (loans ?? []).reduce((s, l) => s + Math.max(0, (l.principal ?? 0) - (repaid.get(l.id) ?? 0)), 0);
      const unpaid = (sal ?? []).filter((s) => s.paid_status !== "paid");
      return {
        loanOutstanding,
        unpaidSalaries: { count: unpaid.length, net: unpaid.reduce((s, r) => s + Math.max(0, (r.net ?? 0) - (r.paid_amount ?? 0)), 0) },
        lastPeriod: (sal ?? [])[0]?.period ?? null,
        docTypes: (docs ?? []).map((d) => d.doc_type),
      };
    },
    staleTime: 30_000,
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: KEY });
  qc.invalidateQueries({ queryKey: ["fixed-assets"] });
}

export function useIssueEmployeeAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { employeeId: string; kind: AssetKind; name: string; identifier?: string | null; fixedAssetId?: string | null; issuedOn: string; notes?: string | null }) => {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      const { data: me } = await supabase.from("users").select("tenant_id").eq("id", auth.user?.id ?? "").maybeSingle();
      if (!me?.tenant_id) throw new Error("Could not find your company — please sign in again.");
      const { error } = await supabase.from("employee_assets").insert({
        tenant_id: me.tenant_id, employee_id: input.employeeId, kind: input.kind, name: input.name.trim(),
        identifier: input.identifier?.trim() || null, fixed_asset_id: input.fixedAssetId ?? null, issued_on: input.issuedOn, notes: input.notes?.trim() || null,
      });
      if (error) throw new Error(error.message.includes("employee_assets_fixed_asset_open_uq") ? "This asset is already with someone else — mark it Returned there first." : error.message);
    },
    onSuccess: () => { invalidate(qc); toast.success("Issued"); },
    onError: (err) => toastError(err, { fallback: "Could not issue" }),
  });
}

export function useReturnEmployeeAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; returnedOn: string | null; condition: ReturnCondition | null; notes?: string | null }) => {
      const supabase = createClient();
      const { error } = await supabase.from("employee_assets")
        .update({ returned_on: input.returnedOn, return_condition: input.returnedOn ? input.condition : null, notes: input.notes ?? undefined, updated_at: new Date().toISOString() })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: (_d, i) => { invalidate(qc); toast.success(i.returnedOn ? "Marked as returned" : "Return undone — back with them"); },
    onError: (err) => toastError(err, { fallback: "Could not update" }),
  });
}

export function useDeleteEmployeeAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("employee_assets").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { invalidate(qc); toast.success("Entry removed"); },
    onError: (err) => toastError(err, { fallback: "Could not delete" }),
  });
}
