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
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { toast } from "sonner";
import { toastError, type ToastErrorAction } from "@/lib/errors/toast-error";

/**
 * R-1873: the loan RPCs refuse with the next step — DETAIL = what to do, HINT = the app page to
 * do it on (the loan's cash line on Banking, or the Loans page). Show both, with a button (§24).
 * Only an in-app /accounting/ path is ever followed.
 */
export function loanErrorToastOptions(
  err: unknown,
  go: (href: string) => void = (href) => window.location.assign(href),
): { description?: string; action?: ToastErrorAction; duration?: number } {
  const e = (err ?? {}) as { details?: unknown; hint?: unknown };
  const description = typeof e.details === "string" && e.details.trim() ? e.details.trim() : undefined;
  const hint = typeof e.hint === "string" && /^\/accounting\/[\w\-/?=&.%]*$/.test(e.hint) ? e.hint : undefined;
  if (!hint) return description ? { description } : {};
  const label = hint.startsWith("/accounting/banking/") ? "Open the cash line" : "Open Loans";
  return { description, action: { label, onClick: () => go(hint) }, duration: 10_000 };
}

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

/**
 * All loans for the tenant with computed repaid / outstanding. R-1582: both reads page past
 * the gateway's 1000-row cap — a repayment dropped at the cap made the loan's outstanding
 * bigger than it is.
 */
export async function fetchEmployeeLoans(supabase: ReturnType<typeof createClient>): Promise<EmployeeLoan[]> {
  const loans = await fetchAllRows((from, to) => supabase
    .from("employee_loans")
    .select("id, tenant_id, employee_name, principal, disbursed_on, bank_account_id, kind, notes, status, created_at")
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to));

  const reps = await fetchAllRows((from, to) => supabase
    .from("employee_loan_repayments")
    .select("loan_id, amount")
    .order("id", { ascending: true })
    .range(from, to));

  const paidByLoan = new Map<string, number>();
  for (const r of reps) {
    paidByLoan.set(r.loan_id, (paidByLoan.get(r.loan_id) ?? 0) + (r.amount ?? 0));
  }

  return loans.map((l) => {
    const repaid = paidByLoan.get(l.id) ?? 0;
    return { ...(l as EmployeeLoanRow), repaid, outstanding: (l.principal ?? 0) - repaid };
  });
}

export function useEmployeeLoans() {
  return useQuery({
    queryKey: ["employee-loans"],
    queryFn: (): Promise<EmployeeLoan[]> => fetchEmployeeLoans(createClient()),
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
      // R-1582: one loan's history can pass a page (an advance spent in many small parts).
      const data = await fetchAllRows((from, to) => supabase
        .from("employee_loan_repayments")
        .select("id, loan_id, amount, repaid_on, method, bank_account_id, expense_id, notes, created_at")
        .eq("loan_id", loanId!)
        .order("repaid_on", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to));

      const rows = data as Omit<LoanRepaymentRow, "expense_category">[];

      // Join the category from the linked expense (spent portions of an advance).
      const expenseIds = rows.map((r) => r.expense_id).filter((v): v is string => Boolean(v));
      const catById = new Map<string, string>();
      const exps = await fetchAllRowsIn(expenseIds, (run, from, to) => supabase
        .from("expenses").select("id, category").in("id", run)
        .order("id", { ascending: true }).range(from, to));
      for (const e of exps) if (e.category) catById.set(e.id, e.category);

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
      qc.invalidateQueries({ queryKey: ["payments-made"] });
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

/** Edit a mistaken loan/advance. R-1873: its cash line changes in place (amount, account, date).
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
      qc.invalidateQueries({ queryKey: ["payments-made"] });
      toast.success("Loan updated");
    },
    onError: (err) => toastError(err, loanErrorToastOptions(err)),
  });
}

/** Delete a mistaken loan/advance. R-1873: the loan and its cash line go together, so Payments
 *  Made, the account balance, this register and the Balance Sheet all lose it at once. Blocked
 *  once it has repayments, or when its line was re-booked on Banking (next step in the toast). */
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
      qc.invalidateQueries({ queryKey: ["payments-made"] });
      toast.success("Loan deleted — its cash line is removed too");
    },
    onError: (err) => toastError(err, loanErrorToastOptions(err)),
  });
}

/**
 * R-1873: a payout line left behind by a loan deleted before R-1873, next to its "Correction"
 * credit. Payments Made shows the payout although no loan backs it. Owner only.
 */
export type LoanGhostPair = {
  payout_id: string; correction_id: string; bank_account_id: string; account_name: string | null;
  person: string; amount: number; payout_date: string; correction_date: string;
};

/* The two R-1873 functions are newer than database.types.ts (shared, regenerated by the
   manager after the migration lands) — called through an untyped client, as owner-equity.ts. */
const untyped = () => createClient() as unknown as SupabaseClient;

export function useLoanGhostPairs(enabled: boolean) {
  return useQuery({
    queryKey: ["employee-loan-ghost-pairs"],
    enabled,
    queryFn: async (): Promise<LoanGhostPair[]> => {
      const { data, error } = await untyped().rpc("employee_loan_ghost_pairs");
      if (error) throw error;
      return (data ?? []) as LoanGhostPair[];
    },
  });
}

/** Removes the payout + its correction together — the balance does not move (R-1873). */
export function useRemoveLoanGhostPair() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: Pick<LoanGhostPair, "payout_id" | "correction_id">) => {
      const { error } = await untyped().rpc("remove_employee_loan_ghost_pair", {
        p_payout_id: p.payout_id, p_correction_id: p.correction_id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee-loan-ghost-pairs"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["payments-made"] });
      toast.success("Left-over lines removed — Payments Made no longer shows that payout");
    },
    onError: (err) => toastError(err, loanErrorToastOptions(err)),
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
