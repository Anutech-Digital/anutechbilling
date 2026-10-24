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
import { payArgs, type Bill194q, type PayInput, type VendorOpenItem, type VendorPayResult } from "@/lib/banking/debit-pay-for";
import { queryKeys } from "@/lib/queries/keys";

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
                         "expenses", "prepaid_advances", "balance-sheet", "payments-made", "vendor_194q", "vendor-payments", "statutory-dues"]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
      qc.invalidateQueries({ queryKey: queryKeys.pnl() });   // the P&L's real key (was ["pnl"], read by nothing)
    },
    onError: (err) => toastError(err),
  });
}

/**
 * R-1891: 194Q on the vendor's open COGS bills — worked out by the database
 * (vendor_bill_194q_calc, migration 20261024230000); the screen only shows it. `buyer` is the
 * company's answer to "turnover last FY above ₹10 crore?" (null = not answered).
 */
export const vendor194qKey = (vendorId: string | null) => ["vendor_194q", vendorId] as const;

export function useVendor194q(vendorId: string | null) {
  return useQuery({
    queryKey: vendor194qKey(vendorId),
    enabled: Boolean(vendorId),
    queryFn: async (): Promise<Bill194q[]> => {
      const { data, error } = await rpc("vendor_194q_open_bills", { p_vendor_id: vendorId });
      if (error) throw error;
      return ((data ?? []) as Bill194q[]).map((r) => ({
        ...r,
        fy_before: num(r.fy_before), base: num(r.base), rate_pct: num(r.rate_pct),
        tds_total: num(r.tds_total), tds_already: num(r.tds_already), tds_due: num(r.tds_due),
      }));
    },
    staleTime: 15_000,
  });
}

/** R-1891: the company's answer to the ₹10 crore question (owner / manager / accountant). */
export function useSet194qBuyer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (value: boolean) => {
      const { error } = await rpc("set_tds_194q_buyer", { p_value: value });
      if (error) throw error;
      return value;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vendor_194q"] }); },
    onError: (err) => toastError(err),
  });
}
