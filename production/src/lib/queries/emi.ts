/**
 * Assets bought on EMI / financing — TanStack Query hooks (migration 0092).
 *
 * A purchase = a fixed asset (total cost) + a down payment (cash out) + a loan
 * (financed = total − down) repaid via EMIs. Each EMI's principal reduces the
 * loan; its interest is an expense. Balance-sheet.ts surfaces the asset + the
 * outstanding loan.
 *
 * R-1864: a purchase is recorded with record_emi_asset_purchase (asset in the register + loan +
 * reducing-balance schedule + fee + down-payment bank line, one step); each EMI is reconciled
 * from its bank line (reconcile_bank_debit_to_emi), paid by hand (pay_next_emi), prepaid
 * (prepay_emi_loan) or undone (undo_emi_payment). Purchases from before R-1864 have no schedule
 * and keep record_emi_payment (Pay EMI with the interest typed in).
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import type { Database } from "@/lib/supabase/database.types";
import { queryKeys } from "@/lib/queries/keys";
import { rupee } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import type { AssetBlock } from "@/lib/accounting/depreciation";
import { toRpcRows, type ScheduleRow } from "@/lib/accounting/emi-schedule";

/* R-1864 columns (migration 20261024200500) — not in the generated types yet. */
type EmiPurchaseR1864 = {
  interest_rate: number | null; no_cost: boolean; first_emi_on: string | null;
  processing_fee: number; processing_fee_gst: number; fee_expense_id: string | null;
  lender_ref: string | null; down_bank_txn_id: string | null;
};
type EmiPaymentR1864 = {
  bank_txn_id: string | null; schedule_seq: number | null; kind: "emi" | "prepayment" | "foreclosure";
  charges: number; charges_expense_id: string | null;
};
export type EmiPurchaseRow = Database["public"]["Tables"]["emi_purchases"]["Row"] & EmiPurchaseR1864;
export type EmiPaymentRow  = Database["public"]["Tables"]["emi_payments"]["Row"] & EmiPaymentR1864;

/* The R-1864 functions and the emi_schedule table are not in the generated types yet (the
   bank-credit-pay-for pattern): a narrow, typed-at-the-edge client. */
type LooseError = { message: string; code?: string } | null;
type LooseQuery<T> = PromiseLike<{ data: T[] | null; error: LooseError }> & {
  eq: (col: string, v: unknown) => LooseQuery<T>;
  in: (col: string, v: readonly unknown[]) => LooseQuery<T>;
  order: (col: string, o?: { ascending: boolean }) => LooseQuery<T>;
  range: (from: number, to: number) => LooseQuery<T>;
};
type LooseClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: LooseError }>;
  from: <T>(table: string) => { select: (cols: string) => LooseQuery<T> };
};
const loose = () => createClient() as unknown as LooseClient;
export type EmiCategory    = EmiPurchaseRow["category"];

export const EMI_CATEGORY_LABEL: Record<EmiCategory, string> = {
  vehicle: "Vehicle", equipment: "Equipment", furniture: "Furniture", property: "Property", other: "Other",
};

export type EmiPurchase = EmiPurchaseRow & {
  principalPaid: number;   // sum of principal parts
  outstanding:   number;   // financed − principalPaid
  emisPaid:      number;   // count of payments
};

/**
 * Every EMI purchase with principal paid / outstanding. R-1582: both reads page past the
 * gateway's 1000-row cap — an EMI dropped at the cap made the outstanding bigger than it is.
 */
export async function fetchEmiPurchases(supabase: ReturnType<typeof createClient>): Promise<EmiPurchase[]> {
  const purchases = await fetchAllRows((from, to) => supabase
    .from("emi_purchases").select("*")
    .order("created_at", { ascending: false }).order("id", { ascending: true })
    .range(from, to));
  const pays = await fetchAllRows((from, to) => supabase
    .from("emi_payments").select("purchase_id, principal_part")
    .order("id", { ascending: true })
    .range(from, to));

  const paidByP = new Map<string, { prin: number; count: number }>();
  for (const p of pays) {
    const cur = paidByP.get(p.purchase_id) ?? { prin: 0, count: 0 };
    cur.prin += p.principal_part ?? 0; cur.count += 1;
    paidByP.set(p.purchase_id, cur);
  }
  return purchases.map((p) => {
    const agg = paidByP.get(p.id) ?? { prin: 0, count: 0 };
    return { ...(p as EmiPurchaseRow), principalPaid: agg.prin, outstanding: (p.financed ?? 0) - agg.prin, emisPaid: agg.count };
  });
}

export function useEmiPurchases() {
  return useQuery({
    queryKey: ["emi-purchases"],
    queryFn: (): Promise<EmiPurchase[]> => fetchEmiPurchases(createClient()),
    staleTime: 30_000,
  });
}

export function useEmiPayments(purchaseId: string | undefined) {
  return useQuery({
    queryKey: ["emi-purchases", "payments", purchaseId],
    enabled: Boolean(purchaseId),
    queryFn: async (): Promise<EmiPaymentRow[]> => {
      const supabase = createClient();
      return (await fetchAllRows((from, to) => supabase
        .from("emi_payments").select("*").eq("purchase_id", purchaseId!)
        .order("paid_on", { ascending: true }).order("id", { ascending: true })
        .range(from, to))) as EmiPaymentRow[];
    },
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["emi-purchases"] });
  qc.invalidateQueries({ queryKey: ["balance-sheet"] });
  qc.invalidateQueries({ queryKey: ["expenses"] });
  qc.invalidateQueries({ queryKey: ["bank_accounts"] });
  qc.invalidateQueries({ queryKey: ["bank_transactions"] });
}

export function useRecordEmiPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      purchaseId: string; amount: number; interest: number; paidOn: string; bankAccountId: string; notes?: string | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("record_emi_payment", {
        p_purchase_id:     input.purchaseId,
        p_amount:          input.amount,
        p_interest:        input.interest,
        p_paid_on:         input.paidOn,
        p_bank_account_id: input.bankAccountId,
        p_notes:           input.notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => { invalidate(qc); toast.success("EMI paid"); },
    onError: (err) => toastError(err),
  });
}

/* ── R-1864: asset bought on EMI / loan — schedule, bank reconcile, prepayment ─────────────── */

export type EmiScheduleRow = {
  id: string; tenant_id: string; purchase_id: string; seq: number; due_on: string; emi: number;
  principal: number; interest: number; balance_after: number; emi_payment_id: string | null; created_at: string;
};
export type EmiRowStatus = "linked" | "paid_by_hand" | "due" | "overdue";

export type EmiScheduleLine = EmiScheduleRow & {
  status: EmiRowStatus;
  /** The payment's bank line, when paid. */
  bankTxnId: string | null;
  charges: number;
  paymentId: string | null;
};

export const EMI_STATUS_LABEL: Record<EmiRowStatus, string> = {
  linked: "Paid · in bank",
  paid_by_hand: "Paid · awaiting statement",
  due: "Due",
  overdue: "Overdue",
};

/** Row status: paid & linked to a statement line / paid by hand (manual line) / due / overdue. */
export function emiRowStatus(row: { due_on: string; emi_payment_id: string | null }, lineSource: string | null | undefined, today: string): EmiRowStatus {
  if (row.emi_payment_id) return lineSource && lineSource !== "manual" ? "linked" : "paid_by_hand";
  return row.due_on < today ? "overdue" : "due";
}

export function useEmiSchedule(purchaseId: string | undefined) {
  return useQuery({
    queryKey: ["emi-purchases", "schedule", purchaseId],
    enabled: Boolean(purchaseId),
    queryFn: async (): Promise<{ rows: EmiScheduleLine[]; payments: EmiPaymentRow[] }> => {
      const supabase = loose();
      const [rows, payments] = await Promise.all([
        fetchAllRows((from, to) => supabase.from<EmiScheduleRow>("emi_schedule").select("*").eq("purchase_id", purchaseId!)
          .order("seq", { ascending: true }).range(from, to)),
        fetchAllRows((from, to) => supabase.from<EmiPaymentRow>("emi_payments").select("*").eq("purchase_id", purchaseId!)
          .order("paid_on", { ascending: true }).order("id", { ascending: true }).range(from, to)),
      ]);
      const txnIds = payments.map((p) => p.bank_txn_id).filter((x): x is string => Boolean(x));
      const source = new Map<string, string>();
      if (txnIds.length > 0) {
        const { data, error } = await supabase.from<{ id: string; source: string }>("bank_transactions").select("id, source").in("id", txnIds);
        if (error) throw error;
        for (const t of data ?? []) source.set(t.id, t.source);
      }
      const payById = new Map(payments.map((p) => [p.id, p]));
      const today = istToday();
      return {
        payments: payments as EmiPaymentRow[],
        rows: (rows as EmiScheduleRow[]).map((r) => {
          const pay = r.emi_payment_id ? payById.get(r.emi_payment_id) : undefined;
          const txn = pay?.bank_txn_id ?? null;
          return {
            ...r,
            status: emiRowStatus(r, txn ? source.get(txn) : null, today),
            bankTxnId: txn,
            charges: pay?.charges ?? 0,
            paymentId: pay?.id ?? null,
          };
        }),
      };
    },
  });
}

function invalidateEmi(qc: ReturnType<typeof useQueryClient>) {
  invalidate(qc);
  qc.invalidateQueries({ queryKey: ["fixed-assets"] });
  qc.invalidateQueries({ queryKey: ["emi-matches"] });
  qc.invalidateQueries({ queryKey: queryKeys.pnl() });
}

export type EmiAssetPurchaseInput = {
  name: string; block: AssetBlock; cost: number; purchasedOn: string;
  downPayment: number; accountId: string | null; downBankTxnId?: string | null;
  lender: string; lenderRef?: string | null; interestRate: number; noCost: boolean;
  processingFee: number; processingFeeGst: number; schedule: ScheduleRow[]; notes?: string | null;
};

/** One step: the asset (register), the loan, its schedule, the fee, the down-payment bank line. */
export function useRecordEmiAssetPurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: EmiAssetPurchaseInput) => {
      const supabase = loose();
      const { data, error } = await supabase.rpc("record_emi_asset_purchase", {
        p: {
          name: input.name, block: input.block, cost: Math.round(input.cost), purchased_on: input.purchasedOn,
          down_payment: Math.round(input.downPayment), account_id: input.accountId, down_bank_txn_id: input.downBankTxnId ?? null,
          lender: input.lender, lender_ref: input.lenderRef ?? null, interest_rate: input.noCost ? 0 : input.interestRate,
          no_cost: input.noCost, processing_fee: Math.round(input.processingFee), processing_fee_gst: Math.round(input.processingFeeGst),
          schedule: toRpcRows(input.schedule), notes: input.notes ?? null,
        },
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => { invalidateEmi(qc); toast.success("Asset, loan and EMI schedule recorded"); },
    onError: (err) => toastError(err),
  });
}

export type EmiMatch = {
  purchase_id: string; purchase_name: string; lender: string | null; seq: number; due_on: string;
  kind: "instalment" | "paid_by_hand" | "down_payment"; expected: number; principal: number; interest: number;
  difference: number; confidence: "exact" | "high" | "low";
};

/** Which EMI could this money-out line be (emi_matches_for_bank_txn — the same rule auto-reconcile uses). */
export function useEmiMatches(txnId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["emi-matches", txnId],
    enabled: Boolean(txnId) && enabled,
    queryFn: async (): Promise<EmiMatch[]> => {
      const supabase = loose();
      const { data, error } = await supabase.rpc("emi_matches_for_bank_txn", { p_txn_id: txnId! });
      if (error) throw error;
      return (data ?? []) as EmiMatch[];
    },
    staleTime: 15_000,
  });
}

export function useReconcileDebitToEmi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      txnId: string; purchaseId: string; seq: number;
      principal?: number; interest?: number; charges?: number; newSchedule?: ScheduleRow[] | null;
    }) => {
      const supabase = loose();
      const { data, error } = await supabase.rpc("reconcile_bank_debit_to_emi", {
        p_txn_id: input.txnId, p_purchase_id: input.purchaseId, p_seq: input.seq,
        ...(input.principal != null ? { p_principal: input.principal } : {}),
        ...(input.interest != null ? { p_interest: input.interest } : {}),
        p_charges: input.charges ?? 0,
        ...(input.newSchedule ? { p_new_schedule: toRpcRows(input.newSchedule) } : {}),
      });
      if (error) throw error;
      return data as { kind: string; principal?: number; interest?: number; charges?: number };
    },
    onSuccess: (r) => {
      invalidateEmi(qc);
      toast.success(r.kind === "down_payment"
        ? "Down payment matched to the bank line"
        : `EMI reconciled — ${rupee(r.principal ?? 0)} principal, ${rupee(r.interest ?? 0)} interest${r.charges ? `, ${rupee(r.charges)} late fee` : ""}`);
    },
    onError: (err) => toastError(err),
  });
}

export function usePayNextEmi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { purchaseId: string; accountId: string; paidOn: string }) => {
      const supabase = loose();
      const { data, error } = await supabase.rpc("pay_next_emi", {
        p_purchase_id: input.purchaseId, p_account_id: input.accountId, p_paid_on: input.paidOn,
      });
      if (error) throw error;
      return data as { seq: number; principal: number; interest: number };
    },
    onSuccess: (r) => { invalidateEmi(qc); toast.success(`EMI ${r.seq} paid — ${rupee(r.principal)} principal, ${rupee(r.interest)} interest`); },
    onError: (err) => toastError(err),
  });
}

export function usePrepayEmiLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      purchaseId: string; principal: number; interest: number; charges: number; paidOn: string;
      accountId: string | null; txnId: string | null; foreclose: boolean; newSchedule: ScheduleRow[] | null;
    }) => {
      const supabase = loose();
      const { data, error } = await supabase.rpc("prepay_emi_loan", {
        p_purchase_id: input.purchaseId, p_principal: Math.round(input.principal), p_interest: Math.round(input.interest),
        p_charges: Math.round(input.charges), p_paid_on: input.paidOn, p_account_id: input.accountId,
        p_txn_id: input.txnId, p_foreclose: input.foreclose,
        p_new_schedule: (input.newSchedule ? toRpcRows(input.newSchedule) : null),
      });
      if (error) throw error;
      return data as { outstanding: number; kind: string };
    },
    onSuccess: (r) => {
      invalidateEmi(qc);
      toast.success(r.outstanding === 0 ? "Loan closed" : `Prepayment recorded — ${rupee(r.outstanding)} still owed`);
    },
    onError: (err) => toastError(err),
  });
}

export function useUndoEmiPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (paymentId: string) => {
      const supabase = loose();
      const { error } = await supabase.rpc("undo_emi_payment", { p_payment_id: paymentId });
      if (error) throw error;
    },
    onSuccess: () => { invalidateEmi(qc); toast.success("Payment undone — the schedule is back as it was"); },
    onError: (err) => toastError(err),
  });
}
