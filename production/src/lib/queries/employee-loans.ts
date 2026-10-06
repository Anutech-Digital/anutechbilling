/**
 * Employee loans / advances — TanStack Query hooks.
 *
 * An employee loan is an ASSET (money owed back to the company), NOT an expense.
 * Disburse + repayment both go through atomic RPCs (migration 0085) that also
 * post the matching bank_transactions leg, so the bank/cash balance and the
 * loan ledger can never drift apart. See also balance-sheet.ts, which surfaces
 * total outstanding as an asset line.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

export type LoanRepaymentMethod = "cash" | "bank" | "salary_deduction" | "expense";
export type EmployeeLoanKind = "loan" | "salary_advance" | "expense_advance";

export const LOAN_KIND_LABEL: Record<EmployeeLoanKind, string> = {
  loan: "Loan",
  salary_advance: "Salary advance",
  expense_advance: "Expense advance",
};

export type EmployeeLoanRow = {
  id:              string;
  tenant_id:       string;
  employee_name:   string;
  principal:       number;
  disbursed_on:    string;
  bank_account_id: string | null;
  kind:            EmployeeLoanKind;
  notes:           string | null;
  status:          "active" | "closed";
  created_at:      string;
};

export type EmployeeLoan = EmployeeLoanRow & {
  repaid:      number;   // sum of repayments so far
  outstanding: number;   // principal − repaid
};

export type LoanRepaymentRow = {
  id:              string;
  loan_id:         string;
  amount:          number;
  repaid_on:       string;
  method:          LoanRepaymentMethod;
  bank_account_id: string | null;
  expense_id:      string | null;
  notes:           string | null;
  created_at:      string;
  /** For method='expense' rows — the category the money was booked under
   *  (joined from the linked expenses row). Null for cash/bank repayments. */
  expense_category: string | null;
};

/** All loans for the tenant with computed repaid / outstanding. */
export function useEmployeeLoans() {
  return useQuery({
    queryKey: ["employee-loans"],
    queryFn: async (): Promise<EmployeeLoan[]> => {
      const supabase = createClient();
      const { data: loans, error } = await supabase
        .from("employee_loans")
        .select("id, tenant_id, employee_name, principal, disbursed_on, bank_account_id, kind, notes, status, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;

      const { data: reps, error: repErr } = await supabase
        .from("employee_loan_repayments")
        .select("loan_id, amount");
      if (repErr) throw repErr;

      const paidByLoan = new Map<string, number>();
      for (const r of reps ?? []) {
        paidByLoan.set(r.loan_id, (paidByLoan.get(r.loan_id) ?? 0) + (r.amount ?? 0));
      }

      return (loans ?? []).map((l) => {
        const repaid = paidByLoan.get(l.id) ?? 0;
        return { ...(l as EmployeeLoanRow), repaid, outstanding: (l.principal ?? 0) - repaid };
      });
    },
    staleTime: 30_000,
  });
}

/** Repayment history for a single loan. */
export function useLoanRepayments(loanId: string | undefined) {
  return useQuery({
    queryKey: ["employee-loans", "repayments", loanId],
    enabled: Boolean(loanId),
    queryFn: async (): Promise<LoanRepaymentRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("employee_loan_repayments")
        .select("id, loan_id, amount, repaid_on, method, bank_account_id, expense_id, notes, created_at")
        .eq("loan_id", loanId!)
        .order("repaid_on", { ascending: true });
      if (error) throw error;

      const rows = (data ?? []) as Omit<LoanRepaymentRow, "expense_category">[];

      // Join the category from the linked expense (spent portions of an advance).
      const expenseIds = rows.map((r) => r.expense_id).filter((v): v is string => Boolean(v));
      const catById = new Map<string, string>();
      if (expenseIds.length) {
        const { data: exps, error: expErr } = await supabase
          .from("expenses").select("id, category").in("id", expenseIds);
        if (expErr) throw expErr;
        for (const e of exps ?? []) if (e.category) catById.set(e.id, e.category);
      }

      return rows.map((r) => ({
        ...r,
        expense_category: r.expense_id ? (catById.get(r.expense_id) ?? null) : null,
      }));
    },
  });
}

/** Disburse a loan — creates the loan + a bank debit (money out) atomically. */
export function useDisburseLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      employeeName: string;
      principal: number;
      disbursedOn: string;
      bankAccountId: string;
      kind: EmployeeLoanKind;
      notes?: string | null;
    }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("disburse_employee_loan", {
        p_employee_name:   input.employeeName,
        p_principal:       input.principal,
        p_disbursed_on:    input.disbursedOn,
        p_bank_account_id: input.bankAccountId,
        p_kind:            input.kind,
        p_notes:           input.notes ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee-loans"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      toast.success("Loan recorded — cash marked out of the account");
    },
    onError: (err) => toastError(err),
  });
}

/** Edit a loan's purpose/note (non-money — plain update, RLS-scoped). */
export function useUpdateLoanNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { loanId: string; notes: string | null }) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("employee_loans")
        .update({ notes: input.notes })
        .eq("id", input.loanId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee-loans"] });
      toast.success("Purpose updated");
    },
    onError: (err) => toastError(err),
  });
}

/** Edit a mistaken loan/advance (money-safe: reverses + re-posts the cash leg).
 *  Only works when the loan has no repayments yet (RPC enforces). */
export function useEditLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      loanId: string; employeeName: string; principal: number; disbursedOn: string;
      bankAccountId: string; kind: EmployeeLoanKind; notes?: string | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("edit_employee_loan", {
        p_loan_id:         input.loanId,
        p_employee_name:   input.employeeName,
        p_principal:       input.principal,
        p_disbursed_on:    input.disbursedOn,
        p_bank_account_id: input.bankAccountId,
        p_kind:            input.kind,
        p_notes:           input.notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee-loans"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      toast.success("Loan updated");
    },
    onError: (err) => toastError(err),
  });
}

/** Delete a mistaken loan/advance (puts the disbursed cash back). Blocked once
 *  it has repayments. */
export function useDeleteEmployeeLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (loanId: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_employee_loan", { p_loan_id: loanId });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee-loans"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      toast.success("Loan deleted — cash restored");
    },
    onError: (err) => toastError(err),
  });
}

/** Record a repayment — reduces outstanding + (cash/bank) a bank credit. */
export function useRecordLoanRepayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      loanId: string;
      amount: number;
      repaidOn: string;
      method: LoanRepaymentMethod;
      bankAccountId?: string | null;
      notes?: string | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("record_employee_loan_repayment", {
        p_loan_id:         input.loanId,
        p_amount:          input.amount,
        p_repaid_on:       input.repaidOn,
        p_method:          input.method,
        p_bank_account_id: input.method === "salary_deduction" ? null : (input.bankAccountId ?? null),
        p_notes:           input.notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee-loans"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      toast.success("Repayment recorded");
    },
    onError: (err) => toastError(err),
  });
}

/**
 * Settle an EXPENSE advance: the spent portion becomes a company expense (no
 * fresh cash out — the cash already left when the advance was given), and any
 * unspent balance is returned to an account (cash in). Atomic (RPC 0086).
 */
export function useSettleExpenseAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      loanId: string;
      spentAmount: number;
      category: string;
      returnAmount: number;
      returnAccountId?: string | null;
      date: string;
      notes?: string | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("settle_expense_advance", {
        p_loan_id:        input.loanId,
        p_spent_amount:   input.spentAmount,
        p_category:       input.category,
        p_return_amount:  input.returnAmount,
        p_return_account: input.returnAmount > 0 ? (input.returnAccountId ?? null) : null,
        p_date:           input.date,
        p_notes:          input.notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee-loans"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      toast.success("Advance settled");
    },
    onError: (err) => toastError(err),
  });
}
