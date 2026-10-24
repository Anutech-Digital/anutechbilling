/**
 * Employee Expense Advances & Petty Cash Management — TanStack Query hooks.
 *
 * R-101 (1 Oct 2026): an advance is a `prepaid_advances` row with category
 * 'Employee advance' — company money in a person's hand, an ASSET. It used to be an
 * 'Employee Advance Disbursal' EXPENSE, which (a) counted the money in the P&L once when
 * handed over and again for every bill, and (b) could never take a spend: the
 * prepaid_advance_id FK points at prepaid_advances, so every insert failed.
 *
 * A spend is an ordinary expense — written by the normal Expense form (bill attach and
 * all) with payment_method 'employee_advance' + prepaid_advance_id. The database trigger
 * (migration 20261001150000) refuses more than what is left and keeps consumed_amount.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queries/keys";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import type { Expense } from "@/lib/queries/expenses";

export type EmployeeAdvance = {
  id: string;
  tenant_id: string;
  employee_id: string | null;
  employee_name: string;
  disbursed_amount: number;
  disbursed_date: string;
  payment_method: string;
  bank_account_id: string | null;
  purpose: string | null;
  status: "active" | "settled" | "closed";
  notes: string | null;
  created_at: string;
  updated_at: string;
  // Computed fields
  total_spent: number;
  remaining_balance: number;
  linked_expenses: Expense[];
};

export const ADVANCE_PAYMENT_METHODS: Record<string, string> = {
  bank_transfer: "Bank Transfer (NEFT/RTGS/IMPS)",
  upi: "UPI (Google Pay / PhonePe / Paytm)",
  cash: "Petty Cash",
  cheque: "Cheque",
};

/** The payment_method an expense carries when it was paid from a staff advance. */
export const EMPLOYEE_ADVANCE_METHOD = "employee_advance";

/** Everything that shows an advance balance, refreshed after any change. */
function refresh(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["employee_expense_advances"] });
  qc.invalidateQueries({ queryKey: ["expenses"] });
  qc.invalidateQueries({ queryKey: ["prepaid_advances"] });
  qc.invalidateQueries({ queryKey: ["balance-sheet"] });
  qc.invalidateQueries({ queryKey: queryKeys.bankAccounts() });
  qc.invalidateQueries({ queryKey: queryKeys.bankTransactions() });
}

export function useEmployeeAdvances() {
  return useQuery({
    queryKey: ["employee_expense_advances"],
    queryFn: async (): Promise<EmployeeAdvance[]> => {
      const res = await fetch("/api/my-advances");
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to load employee advances");
      }
      const data = await res.json();
      return data.advances || [];
    },
  });
}

export function useDisburseAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      employee_name: string;
      disbursed_amount: number;
      disbursed_date: string;
      payment_method: string;
      bank_account_id?: string | null;
      purpose?: string | null;
    }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("give_employee_advance", {
        p_name: input.employee_name,
        p_amount: Math.round(input.disbursed_amount),
        p_date: input.disbursed_date,
        p_method: input.payment_method,
        p_account: input.bank_account_id || undefined,
        p_note: input.purpose || undefined,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => {
      refresh(qc);
      toast.success("Advance given", { description: "Held as company money with them — not an expense until bills come in." });
    },
    onError: (err) => toast.error("Could not give the advance", { description: (err as Error).message }),
  });
}

/** Add money to an open advance (the weekly / monthly refill). */
export function useTopUpAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { advance_id: string; amount: number; date: string; bank_account_id?: string | null }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("top_up_employee_advance", {
        p_advance_id: input.advance_id,
        p_amount: Math.round(input.amount),
        p_date: input.date,
        p_account: input.bank_account_id || undefined,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: (left) => {
      refresh(qc);
      toast.success("Top-up added", { description: `₹${Number(left).toLocaleString("en-IN")} now with them.` });
    },
    onError: (err) => toast.error("Could not add the top-up", { description: (err as Error).message }),
  });
}

export function useRecordAdvanceExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      advance_id: string;
      category: string;
      amount: number;
      expense_date: string;
      vendor_name?: string | null;
      description?: string | null;
      attachment_url?: string | null;
    }) => {
      const res = await fetch("/api/my-advances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to record advance expense");
      }

      const data = await res.json();
      return data.expense;
    },
    onSuccess: () => {
      refresh(qc);
      toast.success("Expense recorded", { description: "Taken from the advance balance." });
    },
    onError: (err) => toast.error("Could not record the expense", { description: (err as Error).message }),
  });
}

/** The person hands back what is left; the advance is closed. */
export function useSettleAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { advance_id: string; date: string; bank_account_id?: string | null }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("settle_employee_advance", {
        p_advance_id: input.advance_id,
        p_date: input.date,
        p_account: input.bank_account_id || undefined,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: (returned) => {
      refresh(qc);
      toast.success("Advance settled", { description: `₹${Number(returned).toLocaleString("en-IN")} returned.` });
    },
    onError: (err) => toast.error("Could not settle", { description: (err as Error).message }),
  });
}

/** Fix an advance entered by mistake: name, purpose, and (while open, no top-up) amount and date. */
export function useUpdateAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { advance_id: string; employee_name: string; amount: number; date: string; purpose: string | null }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("update_employee_advance", {
        p_advance_id: input.advance_id,
        p_name: input.employee_name,
        p_amount: Math.round(input.amount),
        p_date: input.date,
        p_note: input.purpose ?? undefined,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      refresh(qc);
      toast.success("Advance updated");
    },
    onError: (err) => toast.error("Could not update the advance", { description: (err as Error).message }),
  });
}

/** Remove an advance made by mistake — with its expenses only when the person says so. */
export function useDeleteAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { advance_id: string; delete_expenses: boolean }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_employee_advance", {
        p_advance_id: input.advance_id,
        p_delete_expenses: input.delete_expenses,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      refresh(qc);
      toast.success("Advance deleted", { description: "Its petty-cash entries were removed too." });
    },
    onError: (err) => toast.error("Could not delete the advance", { description: (err as Error).message }),
  });
}
