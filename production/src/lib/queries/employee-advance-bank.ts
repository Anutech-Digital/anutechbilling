/**
 * R-1871 — employee office-expense advance from the bank page, and bills against an advance.
 *
 *   book_bank_txn_as_employee_advance(p_txn_id, p_kind, p_name, p_advance_id, p_reimbursement_id, p_note)
 *     'give' / 'top_up' (money-out), 'return' (money-in), 'reimburse' (money-out, pays a pending
 *     reimbursement). Reuses give / top-up / settle_employee_advance and settle_reimbursement;
 *     un-reconciling the line reverses it (trigger). Migration 20261024170000.
 *   add_employee_advance_bills(p_advance_id, p_bills, p_reimburse_extra)
 *     several bills as expenses against the advance; the part over the balance → add_reimbursement.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { rupee } from "@/lib/utils";

const untyped = () => createClient() as unknown as SupabaseClient;

export type EmployeeAdvanceBankKind = "give" | "top_up" | "return" | "reimburse";

export interface BookEmployeeAdvanceResult {
  kind: EmployeeAdvanceBankKind;
  advance_id: string | null;
  reimbursement_id: string | null;
  amount: number;
  /** Balance with the employee afterwards (0 for a reimbursement). */
  left: number;
}

/** Everything that shows an advance, a bank line or a balance-sheet figure. */
function refreshAll(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [["bank_transactions"], ["bank_accounts"], ["employee_expense_advances"], ["prepaid_advances"],
    ["reimbursements"], ["expenses"], ["balance-sheet"], ["pnl"]]) {
    qc.invalidateQueries({ queryKey: key });
  }
}

export function useBookBankTxnAsEmployeeAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      transactionId: string; kind: EmployeeAdvanceBankKind; name?: string | null;
      advanceId?: string | null; reimbursementId?: string | null; note?: string | null;
    }) => {
      const { data, error } = await untyped().rpc("book_bank_txn_as_employee_advance", {
        p_txn_id: input.transactionId,
        p_kind: input.kind,
        p_name: input.name ?? null,
        p_advance_id: input.advanceId ?? null,
        p_reimbursement_id: input.reimbursementId ?? null,
        p_note: input.note ?? null,
      });
      if (error) throw new Error(error.message);
      return data as BookEmployeeAdvanceResult;
    },
    onSuccess: (res) => {
      refreshAll(qc);
      const msg = res.kind === "give" ? "Advance given & reconciled — held as company money with the employee, not an expense"
        : res.kind === "top_up" ? `Top-up added & reconciled — ${rupee(res.left)} now with the employee`
        : res.kind === "return" ? (res.left === 0 ? "Advance returned & reconciled — advance settled" : `Return booked & reconciled — ${rupee(res.left)} still with the employee`)
        : "Reimbursement paid & reconciled";
      toast.success(msg);
    },
    onError: (err) => toastError(err, { fallback: "Couldn't book this line" }),
  });
}

export interface AdvanceBillInput {
  date: string;
  vendor_name?: string | null;
  vendor_id?: string | null;
  category: string;
  amount: number;
  gst: number;
  bill_no?: string | null;
  attachment_url?: string | null;
  note?: string | null;
}

export interface AddBillsResult {
  bills: number; total: number; from_advance: number; reimbursed: number;
  reimbursement_ids: string[]; left: number; employee: string;
}

export function useAddAdvanceBills() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { advanceId: string; bills: AdvanceBillInput[]; reimburseExtra: boolean }) => {
      const { data, error } = await untyped().rpc("add_employee_advance_bills", {
        p_advance_id: input.advanceId,
        p_bills: input.bills,
        p_reimburse_extra: input.reimburseExtra,
      });
      if (error) throw new Error(error.message);
      return data as AddBillsResult;
    },
    onSuccess: (res) => {
      refreshAll(qc);
      toast.success(`${res.bills} bill${res.bills === 1 ? "" : "s"} booked — ${rupee(res.total)} of expenses`, {
        description: res.reimbursed > 0
          ? `${rupee(res.reimbursed)} to reimburse to ${res.employee} (Reimbursements). ${rupee(res.left)} left with them.`
          : `${rupee(res.left)} left with ${res.employee}.`,
      });
    },
    onError: (err) => toastError(err, { fallback: "Couldn't book the bills" }),
  });
}

export interface PendingReimbursement { id: string; person_name: string; amount: number; incurred_on: string; purpose: string; employee_id: string | null }

/** Reimbursements still owed (the money-out choice "Reimbursement to employee" pays one). */
export function usePendingReimbursements(enabled = true) {
  return useQuery({
    queryKey: ["reimbursements", "pending-for-bank"],
    enabled,
    queryFn: async (): Promise<PendingReimbursement[]> => {
      const { data, error } = await untyped()
        .from("reimbursements")
        .select("id, person_name, amount, incurred_on, purpose, employee_id")
        .eq("status", "pending")
        .order("incurred_on", { ascending: true })
        .limit(500);
      if (error) throw new Error(error.message);
      return (data ?? []) as PendingReimbursement[];
    },
  });
}
