/**
 * Prepaid / vendor advances — money paid to a vendor before the service is used
 * (e.g. a Facebook ad top-up). Held as a prepaid ASSET; as the service is used,
 * "consume" books the real expense (P&L) and reduces the balance via an atomic
 * RPC (consume_prepaid_advance).
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { createClient } from "@/lib/supabase/client";
import type { PrepaidAdvanceRow, ExpenseRow } from "@/lib/supabase/database.types";

const KEY = ["prepaid_advances"] as const;

export type PrepaidAdvance = PrepaidAdvanceRow & { balance: number };

/** The expenses booked against one advance (each "Consume"). Lazy — only runs
 *  when a card is expanded. `enabled` gates the fetch. */
export type AdvanceExpense = Pick<
  ExpenseRow, "id" | "amount" | "gst_paid" | "expense_date" | "description" | "notes" | "attachment_url"
>;
export function useAdvanceExpenses(advanceId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["advance_expenses", advanceId],
    enabled: enabled && !!advanceId,
    queryFn: async (): Promise<AdvanceExpense[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("expenses")
        .select("id, amount, gst_paid, expense_date, description, notes, attachment_url")
        .eq("prepaid_advance_id", advanceId!)
        .order("expense_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as AdvanceExpense[];
    },
  });
}

export function usePrepaidAdvances() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<PrepaidAdvance[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("prepaid_advances").select("*")
        /* Staff advances (R-101) share the table but live on Accounting → Advances —
           they are not vendor top-ups, so the Prepaid page, Marketing spend and the bank
           reconcile picker leave them out. */
        .neq("category", "Employee advance")
        .order("paid_date", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((r) => ({ ...r, balance: r.total_amount - r.consumed_amount }));
    },
  });
}

export function useCreatePrepaidAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      vendor_name: string; category: string; total_amount: number;
      paid_date: string; payment_method?: string | null; bank_account_id?: string | null;
      vendor_id?: string | null; notes?: string | null;
      /** Marketing channel; left out → the database guesses it from the vendor name. */
      channel?: string | null;
    }) => {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      const { data: me } = await supabase.from("users").select("tenant_id").eq("id", auth!.user!.id).single();
      const { error } = await supabase.from("prepaid_advances").insert({
        tenant_id: me!.tenant_id,
        vendor_name: input.vendor_name.trim(),
        vendor_id: input.vendor_id ?? null,
        category: input.category || "Marketing",
        total_amount: Math.round(input.total_amount),
        paid_date: input.paid_date,
        payment_method: input.payment_method ?? null,
        bank_account_id: input.bank_account_id ?? null,
        notes: input.notes ?? null,
        channel: input.channel ?? null,
        created_by: auth!.user!.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success("Advance recorded (held as prepaid asset). Reconcile its bank line in Banking.");
    },
    onError: (err) => toastError(err),
  });
}

/** Change the channel an advance pays for — its invoices follow (trigger, 20260926180000). */
export function useSetPrepaidAdvanceChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, channel }: { id: string; channel: string | null }) => {
      const supabase = createClient();
      const { error } = await supabase.from("prepaid_advances").update({ channel }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["marketing-report"] });
      toast.success("Channel updated — is advance ke invoices bhi.");
    },
    onError: (err) => toastError(err),
  });
}

/** Consume part of an advance → books a real expense + reduces the balance (atomic RPC). */
export function useConsumePrepaidAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { advanceId: string; amount: number; date: string; note?: string | null; gst?: number; attachment?: string | null }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("consume_prepaid_advance", {
        p_advance_id: input.advanceId,
        p_amount: Math.round(input.amount),
        p_date: input.date,
        p_note: input.note ?? null,
        p_gst: Math.round(input.gst ?? 0),
        p_attachment: input.attachment ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["advance_expenses"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success("Consumed — expense booked to P&L, advance balance reduced.");
    },
    onError: (err) => toastError(err),
  });
}

export function useDeletePrepaidAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("prepaid_advances").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success("Advance deleted");
    },
    onError: (err) => toastError(err),
  });
}

/**
 * A money-out bank line → a prepaid advance, reconciled to it, in one step
 * (book_bank_txn_as_prepaid). Un-reconciling the line removes the advance, and is
 * refused once any of it has been consumed.
 */
export function useBookBankTxnAsPrepaid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { transactionId: string; accountId: string; vendorName: string; category: string; notes?: string | null }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("book_bank_txn_as_prepaid", {
        p_txn_id: input.transactionId,
        p_vendor_name: input.vendorName.trim(),
        p_category: input.category,
        p_notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, input) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["bank_transactions", input.accountId] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success(`Booked as a ${input.vendorName.trim()} advance (prepaid asset). Book its invoice on the Prepaid page when it arrives.`);
    },
    onError: (err) => toastError(err),
  });
}

/**
 * One vendor invoice drawn from that vendor's open advances, oldest first
 * (consume_prepaid_fifo). All-or-nothing: refused if the open balance is short.
 */
export function useConsumePrepaidFifo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      vendorName: string; amount: number; gst: number; date: string; note?: string | null; attachment?: string | null;
      /** Vendor master link (GSTIN → ITC), bill number, GST by head, TDS — migration 20260927210000. */
      vendorId?: string | null; billNo?: string | null;
      heads?: { igst: number; cgst: number; sgst: number } | null;
      tdsSection?: string | null; tdsAmount?: number;
    }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("consume_prepaid_fifo", {
        p_vendor_name: input.vendorName.trim(),
        p_amount: Math.round(input.amount),
        p_gst: Math.round(input.gst),
        p_date: input.date,
        p_note: input.note ?? null,
        p_attachment: input.attachment ?? null,
        p_vendor_id: input.vendorId ?? null,
        p_bill_no: input.billNo ?? null,
        p_igst: input.heads ? Math.round(input.heads.igst) : null,
        p_cgst: input.heads ? Math.round(input.heads.cgst) : null,
        p_sgst: input.heads ? Math.round(input.heads.sgst) : null,
        p_tds_section: input.tdsAmount && input.tdsAmount > 0 ? (input.tdsSection ?? null) : null,
        p_tds_amount: Math.round(input.tdsAmount ?? 0),
      });
      if (error) throw new Error(error.message);
      return data as number;
    },
    onSuccess: (left, input) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["advance_expenses"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      qc.invalidateQueries({ queryKey: ["vendors"] });
      toast.success(`Invoice booked to P&L. ${input.vendorName.trim()} advance left: ₹${left}.${input.tdsAmount ? ` TDS ₹${input.tdsAmount} recorded — challan mein jodo; vendor ko TDS certificate se credit milega.` : ""}`);
    },
    onError: (err) => toastError(err),
  });
}
