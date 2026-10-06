/**
 * Reimbursements — company expenses paid from a person's own card/cash.
 *
 * add   → books the expense (P&L) + records the payable (pending)   [RPC]
 * settle→ marks it repaid (bank transfer reconciled separately)     [RPC]
 * delete→ undo (also drops the booked expense if still unreconciled)[RPC]
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import type { ReimbursementRow } from "@/lib/supabase/database.types";

export type Reimbursement = ReimbursementRow & { employee_name: string | null };

const RECEIPT_BUCKET = "employee-docs";   // reuse the tenant-scoped private bucket

/** Upload a reimbursement receipt to the private bucket; returns its path. */
export async function uploadReimbursementReceipt(file: File): Promise<string> {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) throw new Error("Not authenticated");
  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", authData.user.id).single();
  if (!me) throw new Error("No tenant");
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
  const path = `${me.tenant_id}/reimbursements/${crypto.randomUUID()}-${safeName}`;
  const { error } = await supabase.storage.from(RECEIPT_BUCKET).upload(path, file, {
    contentType: file.type || undefined, upsert: false,
  });
  if (error) throw new Error(error.message);
  return path;
}

/** Short-lived signed URL to view a reimbursement receipt. */
export async function getReimbursementReceiptUrl(path: string): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.storage.from(RECEIPT_BUCKET).createSignedUrl(path, 60 * 5);
  return data?.signedUrl ?? null;
}

/** Expense categories a reimbursement can fall under (Salaries excluded — those
 *  go through Payroll). */
export const REIMBURSEMENT_CATEGORIES = [
  "Hosting", "Software", "Office", "Marketing", "Travel", "Professional", "Other",
];

export function useReimbursements() {
  return useQuery({
    queryKey: ["reimbursements"],
    queryFn: async (): Promise<Reimbursement[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("reimbursements").select("*")
        .order("status", { ascending: true })          // pending first
        .order("incurred_on", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as ReimbursementRow[];

      // Resolve linked employee names in one follow-up query.
      const empIds = Array.from(new Set(rows.map((r) => r.employee_id).filter(Boolean))) as string[];
      const nameById = new Map<string, string>();
      if (empIds.length) {
        const { data: emps } = await supabase.from("employees").select("id, name").in("id", empIds);
        for (const e of emps ?? []) nameById.set(e.id, e.name);
      }
      return rows.map((r) => ({ ...r, employee_name: r.employee_id ? (nameById.get(r.employee_id) ?? null) : null }));
    },
  });
}

export function useAddReimbursement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      person: string; purpose: string; category: string;
      amount: number; gst?: number; incurredOn: string; paidVia?: string | null;
      employeeId?: string | null; receiptPath?: string | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("add_reimbursement", {
        p_person:      input.person,
        p_purpose:     input.purpose,
        p_category:    input.category,
        p_amount:      Math.round(input.amount),
        p_gst:         Math.round(input.gst ?? 0),
        p_incurred_on: input.incurredOn,
        p_paid_via:    input.paidVia ?? null,
        p_employee_id: input.employeeId ?? null,
        p_receipt_path: input.receiptPath ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reimbursements"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success("Reimbursement recorded (expense booked)");
    },
    onError: (err) => toastError(err),
  });
}

export function useSettleReimbursement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; settledOn: string; notes?: string | null }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("settle_reimbursement", {
        p_id: input.id, p_settled_on: input.settledOn, p_notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reimbursements"] });
      toast.success("Marked settled");
    },
    onError: (err) => toastError(err),
  });
}

export function useDeleteReimbursement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_reimbursement", { p_id: id });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reimbursements"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success("Reimbursement removed");
    },
    onError: (err) => toastError(err),
  });
}
