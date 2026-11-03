/**
 * R-2388 — Private Vault → Loans (tables personal_loans / personal_loan_payments, RPCs
 * personal_loan_record_payment / personal_loan_undo_payment — migration
 * 20261102194900_r2388_personal_loans.sql). Same owner-only RLS as every vault table; every
 * insert stamps owner/tenant from the session (requireIdentity), never a prop.
 *
 * A payment is ONE RPC call: the payment row and its ledger entries (interest = expense
 * "Loan EMI" / interest income; principal = a transfer, not spend or income) land together
 * or not at all (§17b).
 *
 * Its own module so a screen test can mock it in one line. The tables are newer than the
 * generated DB types, so the row shapes are written here and the client is used untyped.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { requireIdentity, invalidateAll } from "@/lib/queries/personal-vault";
import type {
  LoanDirection,
  LoanKind,
  LoanPaymentKind,
  LoanStatus,
  RepayType,
} from "@/lib/vault/personal/loans";

export interface PersonalLoan {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  direction: LoanDirection;
  loan_kind: LoanKind;
  party: string;
  /** Whole rupees. */
  principal: number;
  /** YYYY-MM-DD */
  start_date: string;
  /** % a year. */
  annual_rate: number | null;
  repay_type: RepayType;
  tenure_months: number | null;
  emi_amount: number | null;
  first_due_on: string | null;
  account_id: string | null;
  note: string | null;
  status: LoanStatus;
  closed_on: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonalLoanPayment {
  id: string;
  loan_id: string;
  kind: LoanPaymentKind;
  paid_on: string;
  principal_part: number;
  interest_part: number;
  account_id: string | null;
  note: string | null;
  created_at: string;
}

export type PersonalLoanInput = Pick<
  PersonalLoan,
  | "direction" | "loan_kind" | "party" | "principal" | "start_date" | "annual_rate" | "repay_type"
  | "tenure_months" | "emi_amount" | "first_due_on" | "account_id" | "note"
> & { id?: string };

export interface RecordLoanPaymentInput {
  loan_id: string;
  kind: LoanPaymentKind;
  paid_on: string;
  principal: number;
  interest: number;
  account_id: string | null;
  note: string | null;
}

const LOANS = "personal_loans";
const PAYMENTS = "personal_loan_payments";
const db = () => createClient() as unknown as SupabaseClient;

/** numeric columns come back as strings from PostgREST — make them numbers once, here. */
function toLoan(r: Record<string, unknown>): PersonalLoan {
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    ...(r as unknown as PersonalLoan),
    principal: Number(r.principal),
    annual_rate: num(r.annual_rate),
    tenure_months: num(r.tenure_months),
    emi_amount: num(r.emi_amount),
  };
}

export function usePersonalLoans() {
  return useQuery({
    queryKey: ["personal-vault", "loans"],
    queryFn: async (): Promise<PersonalLoan[]> => {
      const { data, error } = await db()
        .from(LOANS)
        .select("*")
        .order("status")
        .order("start_date", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((r) => toLoan(r as Record<string, unknown>));
    },
    staleTime: 30_000,
  });
}

export function usePersonalLoanPayments() {
  return useQuery({
    queryKey: ["personal-vault", "loan-payments"],
    queryFn: async (): Promise<PersonalLoanPayment[]> => {
      const { data, error } = await db()
        .from(PAYMENTS)
        .select("id, loan_id, kind, paid_on, principal_part, interest_part, account_id, note, created_at")
        .order("paid_on", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []).map((r) => {
        const p = r as Record<string, unknown>;
        return { ...(p as unknown as PersonalLoanPayment), principal_part: Number(p.principal_part), interest_part: Number(p.interest_part) };
      });
    },
    staleTime: 30_000,
  });
}

export function useSavePersonalLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PersonalLoanInput) => {
      const { userId, tenantId } = await requireIdentity();
      const { id, ...fields } = input;
      if (id) {
        const { error } = await db().from(LOANS).update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id);
        if (error) throw error;
        return;
      }
      const { error } = await db().from(LOANS).insert({ ...fields, tenant_id: tenantId, owner_user_id: userId });
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not save the loan." }),
  });
}

/** Close (repaid / settled / written off) or re-open a loan. */
export function useSetLoanStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; status: LoanStatus; closed_on: string | null }) => {
      await requireIdentity();
      const { error } = await db()
        .from(LOANS)
        .update({ status: input.status, closed_on: input.status === "closed" ? input.closed_on : null, updated_at: new Date().toISOString() })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not change the loan." }),
  });
}

export function useDeletePersonalLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db().from(LOANS).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not delete the loan." }),
  });
}

export function useRecordLoanPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecordLoanPaymentInput) => {
      await requireIdentity();
      const { data, error } = await db().rpc("personal_loan_record_payment", {
        p_loan_id: input.loan_id,
        p_kind: input.kind,
        p_paid_on: input.paid_on,
        p_principal: input.principal,
        p_interest: input.interest,
        p_account_id: input.account_id,
        p_note: input.note,
      });
      if (error) throw error;
      return data as { payment_id: string; principal_part: number; interest_part: number; outstanding: number; closed: boolean };
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not record the payment." }),
  });
}

export function useUndoLoanPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (paymentId: string) => {
      await requireIdentity();
      const { data, error } = await db().rpc("personal_loan_undo_payment", { p_payment_id: paymentId });
      if (error) throw error;
      return data as { payment_id: string; reopened: boolean };
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not undo the payment." }),
  });
}
