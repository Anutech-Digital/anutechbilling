/**
 * Employee expense claims — TanStack Query hooks (migration 0093).
 *
 * An employee files a claim against their expense advance from a public link
 * (submit_expense_claim, server-side). The owner reviews PENDING claims here
 * and approves/rejects. Approve runs the atomic settle math (books the expense
 * + reduces the advance, no fresh cash leg); reject just closes the claim.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import type { Database } from "@/lib/supabase/database.types";

export type ExpenseClaimRow = Database["public"]["Tables"]["expense_claims"]["Row"];
export type ClaimStatus = ExpenseClaimRow["status"];

export type ExpenseClaim = ExpenseClaimRow & { employee_name: string };

/** Claims for the tenant, newest first. Pass a status to filter. */
/** Claims for the tenant, newest first. R-1582: paged past the gateway's 1000-row cap. */
export async function fetchExpenseClaims(supabase: ReturnType<typeof createClient>, status?: ClaimStatus): Promise<ExpenseClaim[]> {
  const rows = (await fetchAllRows((from, to) => {
    let q = supabase
      .from("expense_claims")
      .select("*");
    if (status) q = q.eq("status", status);
    return q.order("created_at", { ascending: false }).order("id", { ascending: true }).range(from, to);
  })) as ExpenseClaimRow[];

  // Resolve employee names in one follow-up query (no reliance on embedding).
  const empIds = Array.from(new Set(rows.map((r) => r.employee_id)));
  const nameById = new Map<string, string>();
  const emps = await fetchAllRowsIn(empIds, (run, from, to) => supabase.from("employees")
    .select("id, name").in("id", run).order("id", { ascending: true }).range(from, to));
  for (const e of emps) nameById.set(e.id, e.name);
  return rows.map((r) => ({ ...r, employee_name: nameById.get(r.employee_id) ?? "Employee" }));
}

export function useExpenseClaims(status?: ClaimStatus) {
  return useQuery({
    queryKey: ["expense-claims", status ?? "all"],
    queryFn: (): Promise<ExpenseClaim[]> => fetchExpenseClaims(createClient(), status),
    staleTime: 20_000,
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["expense-claims"] });
  qc.invalidateQueries({ queryKey: ["employee-loans"] });
  qc.invalidateQueries({ queryKey: ["expenses"] });
  qc.invalidateQueries({ queryKey: ["balance-sheet"] });
}

export function useApproveClaim() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (claimId: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("approve_expense_claim", { p_claim_id: claimId });
      if (error) throw error;
    },
    onSuccess: () => { invalidate(qc); toast.success("Claim approved — advance adjusted"); },
    onError: (err) => toastError(err),
  });
}

export function useRejectClaim() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { claimId: string; reason?: string | null }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("reject_expense_claim", {
        p_claim_id: input.claimId,
        p_reason:   input.reason ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => { invalidate(qc); toast.success("Claim rejected"); },
    onError: (err) => toastError(err),
  });
}

export function useEditClaim() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      claimId: string; amount: number; category: string; purpose?: string | null; spentOn: string;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("edit_expense_claim", {
        p_claim_id: input.claimId,
        p_amount:   input.amount,
        p_category: input.category,
        p_purpose:  input.purpose ?? null,
        p_spent_on: input.spentOn,
      });
      if (error) throw error;
    },
    onSuccess: () => { invalidate(qc); toast.success("Claim updated"); },
    onError: (err) => toastError(err),
  });
}

export function useDeleteClaim() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (claimId: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_expense_claim", { p_claim_id: claimId });
      if (error) throw error;
    },
    onSuccess: () => { invalidate(qc); toast.success("Claim deleted"); },
    onError: (err) => toastError(err),
  });
}

/** Short-lived signed URL to view a claim's receipt photo (private bucket). */
export async function getClaimReceiptUrl(path: string): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.storage.from("expense-receipts").createSignedUrl(path, 60 * 30);
  return data?.signedUrl ?? null;
}

/** Fetch the tenant's shareable claim link (signed server-side). */
export function useClaimLink() {
  return useQuery({
    queryKey: ["expense-claim-link"],
    queryFn: async (): Promise<string> => {
      const res = await fetch("/api/expense-claim/link");
      if (!res.ok) throw new Error("Could not build the link");
      const json = await res.json();
      return json.url as string;
    },
    staleTime: 5 * 60_000,
  });
}
