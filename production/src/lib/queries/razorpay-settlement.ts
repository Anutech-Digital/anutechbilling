/**
 * R-2099 — Banking → Reconcile → "Razorpay settlement": the read (what the settlement carried,
 * matched to the app's payments) and the one-click reconcile. Both are one call to
 * /api/banking/razorpay-settlement; the server re-reads Razorpay on Reconcile, so the browser
 * never supplies a number.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidateReceivables } from "@/lib/queries/receivables-refresh";
import type { SettlementLookup } from "@/lib/razorpay/settlement-match";
import type { MonthBatchLookup, MonthBatch, BatchRow } from "@/lib/razorpay/settlement-batch";

export type { SettlementLookup };

export interface SettlementReconciled {
  settlement_id: string;
  payments: number;
  gross: number;
  refunds: number;
  fee: number;
  fee_booked_now: number;
  fee_gst_now: number;
  fee_expense_id: string | null;
  /** R-2745: the fee expense's day — the first open (not GST-filed) day; null when no fee was booked now */
  fee_expense_date: string | null;
  /** R-2745: why that day is not the bank line's day (R-2621 gst_filed_why); null when it did not move */
  fee_date_why: string | null;
  /** R-2918: rupees of the settlement booked as Other income (payments that are in no app payment); 0 / absent when none */
  other_income?: number;
  other_income_payments?: number;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const body = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (!res.ok || !body || body.ok === false) {
    throw new Error(body?.error ?? `The server answered ${res.status} — try again.`);
  }
  return body;
}

export const razorpaySettlementKey = (txnId: string | null, settlementId: string | null) =>
  ["razorpay_settlement", txnId, settlementId] as const;

/** Fetched only when the user asks (enabled) — every read is a call to Razorpay. */
export function useRazorpaySettlement(txnId: string | null, settlementId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: razorpaySettlementKey(txnId, settlementId),
    enabled: Boolean(txnId) && enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const qs = new URLSearchParams({ txnId: txnId as string });
      if (settlementId) qs.set("settlementId", settlementId);
      const body = await call<{ result: SettlementLookup; canBookOtherIncome?: boolean }>(`/api/banking/razorpay-settlement?${qs.toString()}`);
      /* R-2918: whether this user may pick "Book as Other income" travels with the plan. */
      return body.result.state === "plan" ? { ...body.result, canBookOtherIncome: body.canBookOtherIncome === true } : body.result;
    },
  });
}

export function useReconcileRazorpaySettlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { txnId: string; settlementId: string | null; picks: Record<string, string>; /** R-2918 */ otherIncome?: string[] }) => {
      const body = await call<{ reconciled: SettlementReconciled }>("/api/banking/razorpay-settlement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txnId: input.txnId,
          ...(input.settlementId ? { settlementId: input.settlementId } : {}),
          picks: input.picks,
          ...(input.otherIncome?.length ? { otherIncome: input.otherIncome } : {}),
        }),
      });
      return body.reconciled;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["razorpay_settlement"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      invalidateReceivables(qc);
    },
  });
}

/* ── R-2654: a whole month at once ─────────────────────────────────────────────────────────── */

export type { MonthBatchLookup, MonthBatch, BatchRow };

export interface MonthRunResult {
  runId: string | null;
  booked: Array<{ txnId: string; settlementId: string; amount: number; fee: number; feeNow?: number; feeDate?: string | null; feeDateWhy?: string | null; /** R-2918 */ otherIncome?: number }>;
  refused: Array<{ txnId: string; message: string }>;
}
export interface MonthUndoResult {
  undone: number;
  left: Array<{ txn_id: string; txn_date: string; credit: number; reason: string }>;
}

const MONTH_URL = "/api/banking/razorpay-settlement/month";

/** The ready / blocked table — one Razorpay read for the month; nothing saved. */
export function useRazorpayMonthBatch(accountId: string, month: string | null) {
  return useQuery({
    queryKey: ["razorpay_settlement", "month", accountId, month],
    enabled: Boolean(month),
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const qs = new URLSearchParams({ accountId, month: month as string });
      return (await call<{ result: MonthBatchLookup }>(`${MONTH_URL}?${qs.toString()}`)).result;
    },
  });
}

/** After a run / undo: the bank lines, the month table, expenses and what customers owe. */
export function invalidateBank(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["bank_transactions"] });
  qc.invalidateQueries({ queryKey: ["razorpay_settlement"] });
  qc.invalidateQueries({ queryKey: ["expenses"] });
  invalidateReceivables(qc);
}

/** One chunk of "Reconcile all ready" — the server plans again and books under one run id. The sheet
 *  sends the chunks one after another and refreshes the bank page once at the end (invalidateBank). */
export function useRunRazorpayMonth() {
  return useMutation({
    mutationFn: async (input: { accountId: string; month: string; txnIds: string[]; runId?: string | null; /** R-2918: line id → Razorpay payment ids picked "Book as Other income" */ otherIncome?: Record<string, string[]> }) =>
      (await call<{ run: MonthRunResult }>(MONTH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run", accountId: input.accountId, month: input.month, txnIds: input.txnIds, ...(input.runId ? { runId: input.runId } : {}),
          ...(input.otherIncome && Object.keys(input.otherIncome).length ? { otherIncome: input.otherIncome } : {}),
        }),
      })).run,
  });
}

/** "Undo this run". */
export function useUndoRazorpayMonth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string) =>
      (await call<{ undo: MonthUndoResult }>(MONTH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "undo", runId }),
      })).undo,
    onSuccess: () => invalidateBank(qc),
  });
}
