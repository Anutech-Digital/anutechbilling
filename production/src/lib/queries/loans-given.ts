/**
 * Loans given (R-544, migration 20261010140000) — money this business LENT to an outside
 * person or company. Staff loans are employee-loans.ts; loans the company TOOK are
 * business-loans.ts.
 *
 * give      → RPC give_loan             (cash out of the chosen account + asset)
 * repayment → RPC record_loan_repayment (cash in; interest first, then principal)
 * delete    → RPC delete_loan_given     (only before any repayment; reverses the cash-out)
 *
 * The maths (interest, schedule, overdue) is lib/accounting/loans-given.ts.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/lib/supabase/database.generated";
import {
  loanPosition, loanSchedule, nextDue, overdueAmount,
  type LoanTerms, type LoanPosition, type RepaymentPart, type RepaymentPlan, type ScheduleRow,
} from "@/lib/accounting/loans-given";
import { istToday } from "@/lib/dates/ist";

export type LoanGivenRow = Tables<"loans_given">;
export type LoanRepaymentRow = Tables<"loan_repayments">;
export type RepaymentMode = "bank" | "upi" | "cash" | "cheque";

export const MODE_LABEL: Record<RepaymentMode, string> = {
  bank: "Bank transfer", upi: "UPI", cash: "Cash", cheque: "Cheque",
};

export interface LoanGiven extends LoanGivenRow {
  terms: LoanTerms;
  repayments: LoanRepaymentRow[];
  parts: RepaymentPart[];
  position: LoanPosition;
  schedule: ScheduleRow[];
  next: ScheduleRow | null;
  overdue: number;
}

export function termsOf(l: LoanGivenRow): LoanTerms {
  return {
    principal: l.principal,
    givenOn: l.given_on,
    interestRate: Number(l.interest_rate) || 0,
    plan: (l.repayment_plan as RepaymentPlan) ?? "one_shot",
    dueOn: l.due_on,
    instalments: l.instalments,
  };
}

/** Builds the derived view of one loan as of `today`. Exported for tests. */
export function buildLoan(l: LoanGivenRow, reps: LoanRepaymentRow[], today: string): LoanGiven {
  const terms = termsOf(l);
  const parts: RepaymentPart[] = reps.map((r) => ({
    repaidOn: r.repaid_on, amount: r.amount, principalPart: r.principal_part, interestPart: r.interest_part,
  }));
  const position = loanPosition(terms, parts, today);
  const schedule = loanSchedule(terms, position.principalRepaid, today);
  const closed = l.status === "closed";
  return {
    ...l, terms, repayments: reps, parts, position, schedule,
    next: closed ? null : nextDue(schedule),
    overdue: closed ? 0 : overdueAmount(schedule),
  };
}

export function useLoansGiven(enabled = true) {
  return useQuery({
    queryKey: ["loans-given"],
    enabled,
    queryFn: async (): Promise<LoanGiven[]> => {
      const supabase = createClient();
      const { data: loans, error } = await supabase
        .from("loans_given").select("*").order("given_on", { ascending: false }).order("id");
      if (error) throw error;
      const { data: reps, error: rErr } = await supabase
        .from("loan_repayments").select("*").order("repaid_on", { ascending: true }).order("id");
      if (rErr) throw rErr;
      const byLoan = new Map<string, LoanRepaymentRow[]>();
      for (const r of reps ?? []) {
        const list = byLoan.get(r.loan_id) ?? [];
        list.push(r);
        byLoan.set(r.loan_id, list);
      }
      const today = istToday();
      return (loans ?? []).map((l) => buildLoan(l, byLoan.get(l.id) ?? [], today));
    },
    staleTime: 30_000,
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["loans-given"] });
  qc.invalidateQueries({ queryKey: ["balance-sheet"] });
  qc.invalidateQueries({ queryKey: ["bank_accounts"] });
  qc.invalidateQueries({ queryKey: ["bank_transactions"] });
}

export interface GiveLoanInput {
  borrowerName: string;
  borrowerType: "person" | "company";
  principal: number;
  givenOn: string;
  paidFromAccountId: string;
  interestRate: number;
  plan: RepaymentPlan;
  dueOn: string | null;
  instalments: number | null;
  customerId: string | null;
  vendorId: string | null;
  notes: string | null;
}

export function useGiveLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: GiveLoanInput) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("give_loan", {
        p_borrower_name:  input.borrowerName,
        p_borrower_type:  input.borrowerType,
        p_principal:      Math.round(input.principal),
        p_given_on:       input.givenOn,
        p_paid_from:      input.paidFromAccountId,
        p_interest_rate:  input.interestRate,
        p_repayment_plan: input.plan,
        ...(input.dueOn ? { p_due_on: input.dueOn } : {}),
        ...(input.plan === "instalments" && input.instalments ? { p_instalments: input.instalments } : {}),
        ...(input.customerId ? { p_customer_id: input.customerId } : {}),
        ...(input.vendorId ? { p_vendor_id: input.vendorId } : {}),
        ...(input.notes ? { p_notes: input.notes } : {}),
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => { invalidate(qc); toast.success("Loan recorded — money taken out of the account"); },
    onError: (err) => toastError(err, { fallback: "Couldn't save the loan", description: "Nothing was saved. Check the details and try again." }),
  });
}

export function useRecordLoanRepayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      loanId: string; repaidOn: string; amount: number; interestPart: number; bankAccountId: string;
      mode: RepaymentMode; reference: string | null; notes: string | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("record_loan_repayment", {
        p_loan_id:         input.loanId,
        p_repaid_on:       input.repaidOn,
        p_amount:          Math.round(input.amount),
        p_interest_part:   Math.round(input.interestPart),
        p_bank_account_id: input.bankAccountId,
        p_mode:            input.mode,
        ...(input.reference ? { p_reference: input.reference } : {}),
        ...(input.notes ? { p_notes: input.notes } : {}),
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { invalidate(qc); toast.success("Repayment recorded"); },
    onError: (err) => toastError(err, { fallback: "Couldn't record the repayment", description: "Nothing was saved. Check the amount and try again." }),
  });
}

export function useDeleteLoanGiven() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (loanId: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_loan_given", { p_loan_id: loanId });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { invalidate(qc); toast.success("Loan deleted — the money is back in the account"); },
    onError: (err) => toastError(err, { fallback: "Couldn't delete the loan", description: "A loan with repayments stays as history." }),
  });
}

/** Principal still owed to the business across all loans given — the Balance Sheet asset.
 *  One total from `loans_given_asset()` (no borrower names), so the manager's sheet balances too. */
export async function fetchLoansGivenAsset(): Promise<number> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("loans_given_asset");
  if (error) throw error;
  return Math.max(0, Number(data ?? 0));
}
