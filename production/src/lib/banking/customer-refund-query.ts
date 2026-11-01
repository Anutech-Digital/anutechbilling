/**
 * R-2322 — reads and writes for Banking → Reconcile → Customer refund.
 *
 * customer_refundable_items / reconcile_bank_debit_as_customer_refund
 * (migration 20261101013533_r2322_bank_customer_refund.sql) are newer than the generated types,
 * so they go through an untyped client (as lib/queries/owner-equity.ts does).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { invalidateReceivables } from "@/lib/queries/receivables-refresh";
import { rupee } from "@/lib/utils";
import type { RefundableItem } from "./customer-refund";

const untyped = () => createClient() as unknown as SupabaseClient;

export const CUSTOMER_REFUNDABLE_KEY = ["customer_refundable_items"] as const;

/** What this customer can be refunded (open credit-note credit, unused advances). */
export function useCustomerRefundables(customerId: string | null) {
  return useQuery({
    queryKey: [...CUSTOMER_REFUNDABLE_KEY, customerId],
    enabled: Boolean(customerId),
    queryFn: async (): Promise<RefundableItem[]> => {
      const { data, error } = await untyped().rpc("customer_refundable_items", { p_customer_id: customerId });
      if (error) throw new Error(error.message);
      return (data ?? []) as RefundableItem[];
    },
  });
}

export interface CustomerRefundResult {
  refund_id: string;
  kind: "credit_note" | "advance";
  amount: number;
  refund_voucher_no: string | null;
  invoice_id: string | null;
}

/** Book the bank line as the refund (one transaction on the server; undo = Un-reconcile). */
export function useBookCustomerRefund() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { transactionId: string; paymentId: string; reason: string }): Promise<CustomerRefundResult> => {
      const { data, error } = await untyped().rpc("reconcile_bank_debit_as_customer_refund", {
        p_txn_id: input.transactionId,
        p_payment_id: input.paymentId,
        p_reason: input.reason.trim(),
      });
      if (error) throw new Error(error.message);
      if (!data) throw new Error("The refund was not confirmed — refresh Banking to see whether it was booked.");
      return data as CustomerRefundResult;
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: CUSTOMER_REFUNDABLE_KEY });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
      invalidateReceivables(qc);
      toast.success(`Refund booked & reconciled — voucher ${r.refund_voucher_no ?? "issued"}`, {
        description: `${rupee(r.amount)} back to the customer; their credit is lower by the same amount.`,
      });
    },
    onError: (err) => toastError(err, { fallback: "Refund not booked — nothing was changed. Try again." }),
  });
}
