/**
 * R-1838 — the money-in "This money is for:" step: its reads and its two writes.
 *
 * Every write is ONE server call, one transaction (migration 20261024131600):
 *   reconcile_bank_credit_to_item   — an open quote / invoice of the customer
 *   reconcile_bank_credit_new_sale  — a new sale (seats × unit price) with no quote yet
 * Both go through record_desk_payment → (generate_invoice) → reconcile_bank_txn. Nothing here
 * computes money: the result the sheet shows is what the database did.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toastInvoiceIssueError } from "@/lib/queries/invoices";
import { invalidateReceivables } from "@/lib/queries/receivables-refresh";
import type { OpenItem, PayForResult, SaleLine } from "@/lib/banking/credit-pay-for";
import { saleLinesPayload } from "@/lib/banking/credit-pay-for";

/* The generated types do not know the R-1838 functions yet (migration not applied there). */
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> };
const rpc = (fn: string, args: Record<string, unknown>) => (createClient() as unknown as RpcClient).rpc(fn, args);

export const openItemsKey = (customerId: string | null) => ["bank_credit_open_items", customerId] as const;

/** What this customer still owes: open renewal / add-seats / new quotes and unpaid invoices. */
export function useBankCreditOpenItems(customerId: string | null) {
  return useQuery({
    queryKey: openItemsKey(customerId),
    enabled: Boolean(customerId),
    queryFn: async (): Promise<OpenItem[]> => {
      const { data, error } = await rpc("bank_credit_open_items", { p_customer_id: customerId });
      if (error) throw error;
      return ((data ?? []) as OpenItem[]).map((r) => ({
        ...r,
        amount_due: Number(r.amount_due) || 0,
        taxable_value: Number(r.taxable_value) || 0,
      }));
    },
    staleTime: 15_000,
  });
}

export interface PayItemInput {
  transactionId: string;
  quoteId: string | null;
  invoiceId: string | null;
  tdsAmount: number;
  tdsRatePct: number | null;
  /** null = not a new subscription sale (the server ignores it). */
  createSubscription: boolean | null;
  subStart: string | null;
  /** Sent only when the operator changed it; else the term decides. */
  subRenewal: string | null;
}

export interface NewSaleInput {
  transactionId: string;
  customerId: string;
  lines: readonly SaleLine[];
  createSubscription: boolean;
  subStart: string | null;
  subRenewal: string | null;
  tdsAmount: number;
  tdsRatePct: number | null;
}

/** The RPC arguments — exported so the tests pin exactly what reaches the server. */
export function payItemArgs(i: PayItemInput) {
  return {
    p_txn_id: i.transactionId,
    p_quote_id: i.invoiceId ? null : i.quoteId,
    p_invoice_id: i.invoiceId,
    p_tds_amount: Math.max(0, Math.round(i.tdsAmount)),
    p_tds_rate_pct: i.tdsAmount > 0 ? i.tdsRatePct : null,
    p_tds_section: i.tdsAmount > 0 ? "194J" : null,
    p_create_subscription: i.createSubscription,
    p_sub_start: i.createSubscription ? i.subStart : null,
    p_sub_renewal: i.createSubscription ? i.subRenewal : null,
  };
}

export function newSaleArgs(i: NewSaleInput) {
  return {
    p_txn_id: i.transactionId,
    p_customer_id: i.customerId,
    p_lines: saleLinesPayload(i.lines),
    p_create_subscription: i.createSubscription,
    p_sub_start: i.createSubscription ? i.subStart : null,
    p_sub_renewal: i.createSubscription ? i.subRenewal : null,
    p_tds_amount: Math.max(0, Math.round(i.tdsAmount)),
    p_tds_rate_pct: i.tdsAmount > 0 ? i.tdsRatePct : null,
    p_tds_section: i.tdsAmount > 0 ? "194J" : null,
  };
}

function useAfterPay() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["bank_transactions"] });
    qc.invalidateQueries({ queryKey: ["bank_credit_open_items"] });
    qc.invalidateQueries({ queryKey: ["subscriptions"] });
    qc.invalidateQueries({ queryKey: ["quotes"] });
    qc.invalidateQueries({ queryKey: ["payments"] });
    invalidateReceivables(qc);
  };
}

/** A missing company GSTIN / address (R-1643) gets its one-click fix; anything else is said plainly. */
const onPayError = (err: unknown) => toastInvoiceIssueError(err);

export function usePayItemFromBankCredit() {
  const after = useAfterPay();
  return useMutation({
    mutationFn: async (input: PayItemInput): Promise<PayForResult> => {
      const { data, error } = await rpc("reconcile_bank_credit_to_item", payItemArgs(input));
      if (error) throw error;
      if (!data) throw new Error("The payment was not confirmed — refresh the page to see whether it was saved.");
      return data as PayForResult;
    },
    onSuccess: after,
    onError: onPayError,
  });
}

export function useNewSaleFromBankCredit() {
  const after = useAfterPay();
  return useMutation({
    mutationFn: async (input: NewSaleInput): Promise<PayForResult> => {
      const { data, error } = await rpc("reconcile_bank_credit_new_sale", newSaleArgs(input));
      if (error) throw error;
      if (!data) throw new Error("The sale was not confirmed — refresh the page to see whether it was saved.");
      return data as PayForResult;
    },
    onSuccess: after,
    onError: onPayError,
  });
}
