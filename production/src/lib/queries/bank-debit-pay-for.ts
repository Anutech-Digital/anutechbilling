/**
 * R-1866 — the money-out "This payment is for:" step: its read and its one write.
 *
 *   bank_debit_vendor_open_items     — a vendor's COGS bills + unpaid expense bills, with what is due
 *   reconcile_bank_debit_to_vendor   — ONE transaction (migration 20261024160000): settles the
 *       bills, records a bill typed on the spot, the TDS, an advance and a bank charge, and
 *       reconciles the line; refuses when the parts do not add up to the bank debit.
 * Nothing here computes money: the result the sheet shows is what the database did.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { payArgs, type PayInput, type VendorOpenItem, type VendorPayResult } from "@/lib/banking/debit-pay-for";

/* The generated types do not know the R-1866 functions yet (migration not applied there). */
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> };
const rpc = (fn: string, args: Record<string, unknown>) => (createClient() as unknown as RpcClient).rpc(fn, args);

export const vendorOpenItemsKey = (vendorId: string | null) => ["bank_debit_vendor_open_items", vendorId] as const;

const num = (v: unknown) => Number(v) || 0;

/** The vendor's open bills, oldest first — amounts from the database. */
export function useVendorOpenItems(vendorId: string | null) {
  return useQuery({
    queryKey: vendorOpenItemsKey(vendorId),
    enabled: Boolean(vendorId),
    queryFn: async (): Promise<VendorOpenItem[]> => {
      const { data, error } = await rpc("bank_debit_vendor_open_items", { p_vendor_id: vendorId });
      if (error) throw error;
      return ((data ?? []) as VendorOpenItem[]).map((r) => ({
        ...r,
        total: num(r.total), amount_due: num(r.amount_due), gst: num(r.gst),
        tds_base: num(r.tds_base), tds_amount: num(r.tds_amount),
      }));
    },
    staleTime: 15_000,
  });
}

export function usePayVendorFromBankDebit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PayInput): Promise<VendorPayResult> => {
      const { data, error } = await rpc("reconcile_bank_debit_to_vendor", payArgs(input));
      if (error) throw error;
      if (!data) throw new Error("The payment was not confirmed — refresh the page to see whether it was saved.");
      return data as VendorPayResult;
    },
    onSuccess: () => {
      for (const key of ["bank_transactions", "bank_accounts", "bank_debit_vendor_open_items", "vendor_bills", "vendors",
                         "expenses", "prepaid_advances", "balance-sheet", "payments-made", "pnl"]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (err) => toastError(err),
  });
}
