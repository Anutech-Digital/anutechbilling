/**
 * Business loans TAKEN by the company (migration 0131) — the mirror of
 * employee loans. Borrowing cash (e.g. a ₹10L HDFC term loan): the principal
 * lands in a bank account and becomes a liability; each EMI's principal reduces
 * it while the interest is booked as an expense.
 *
 * record → RPC record_business_loan (cash in + liability)
 * pay EMI → RPC record_loan_emi (cash out; principal↓ liability, interest → expense)
 * delete → RPC delete_business_loan (only before any EMI; reverses the disbursal)
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import type { BusinessLoanRow, BusinessLoanPaymentRow } from "@/lib/supabase/database.types";

export type BusinessLoan = BusinessLoanRow & {
  principalPaid: number;   // sum of principal parts repaid
  interestPaid:  number;   // sum of interest parts (total finance cost so far)
  outstanding:   number;   // principal − principalPaid
  emisPaid:      number;   // count of EMI payments
};

export function useBusinessLoans() {
  return useQuery({
    queryKey: ["business-loans"],
    queryFn: async (): Promise<BusinessLoan[]> => {
      const supabase = createClient();
      const { data: loans, error } = await supabase
        .from("business_loans").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      const { data: pays, error: pErr } = await supabase
        .from("business_loan_payments").select("loan_id, principal_part, interest_part");
      if (pErr) throw pErr;

      const agg = new Map<string, { prin: number; int: number; count: number }>();
      for (const p of pays ?? []) {
        const cur = agg.get(p.loan_id) ?? { prin: 0, int: 0, count: 0 };
        cur.prin += p.principal_part ?? 0;
        cur.int  += p.interest_part ?? 0;
        cur.count += 1;
        agg.set(p.loan_id, cur);
      }
      return (loans ?? []).map((l) => {
        const a = agg.get(l.id) ?? { prin: 0, int: 0, count: 0 };
        return {
          ...(l as BusinessLoanRow),
          principalPaid: a.prin,
          interestPaid:  a.int,
          outstanding:   (l.principal ?? 0) - a.prin,
          emisPaid:      a.count,
        };
      });
    },
    staleTime: 30_000,
  });
}

export function useLoanPayments(loanId: string | undefined) {
  return useQuery({
    queryKey: ["business-loans", "payments", loanId],
    enabled: Boolean(loanId),
    queryFn: async (): Promise<BusinessLoanPaymentRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("business_loan_payments").select("*").eq("loan_id", loanId!).order("paid_on", { ascending: true });
      if (error) throw error;
      return (data ?? []) as BusinessLoanPaymentRow[];
    },
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["business-loans"] });
  qc.invalidateQueries({ queryKey: ["balance-sheet"] });
  qc.invalidateQueries({ queryKey: ["expenses"] });
  qc.invalidateQueries({ queryKey: ["bank_accounts"] });
  qc.invalidateQueries({ queryKey: ["bank_transactions"] });
}

export function useRecordBusinessLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      lender: string; purpose?: string | null; principal: number; interestRate?: number | null;
      tenureMonths?: number | null; emiAmount?: number | null; disbursedOn: string; depositAccountId: string;
    }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("record_business_loan", {
        p_lender:          input.lender,
        p_purpose:         input.purpose ?? null,
        p_principal:       Math.round(input.principal),
        p_interest_rate:   input.interestRate ?? null,
        p_tenure_months:   input.tenureMonths ?? null,
        p_emi_amount:      input.emiAmount != null ? Math.round(input.emiAmount) : null,
        p_disbursed_on:    input.disbursedOn,
        p_deposit_account: input.depositAccountId,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => { invalidate(qc); toast.success("Loan recorded — cash added to the account"); },
    onError: (err) => toastError(err),
  });
}

export function useRecordLoanEmi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      loanId: string; amount: number; interest: number; paidOn: string; bankAccountId: string; notes?: string | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("record_loan_emi", {
        p_loan_id:         input.loanId,
        p_amount:          Math.round(input.amount),
        p_interest:        Math.round(input.interest),
        p_paid_on:         input.paidOn,
        p_bank_account_id: input.bankAccountId,
        p_notes:           input.notes ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { invalidate(qc); toast.success("EMI recorded"); },
    onError: (err) => toastError(err),
  });
}

export function useDeleteBusinessLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (loanId: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_business_loan", { p_loan_id: loanId });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { invalidate(qc); toast.success("Loan removed"); },
    onError: (err) => toastError(err),
  });
}
