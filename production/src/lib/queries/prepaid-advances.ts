/**
 * Prepaid / vendor advances — money paid to a vendor before the service is used
 * (e.g. a Facebook ad top-up). Held as a prepaid ASSET; as the service is used,
 * "consume" books the real expense (P&L) and reduces the balance via an atomic
 * RPC (consume_prepaid_advance).
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

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
        .from("prepaid_advances").select("*").order("paid_date", { ascending: false });
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
        created_by: auth!.user!.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success("Advance recorded (held as prepaid asset). Reconcile its bank line in Banking.");
    },
    onError: (err) => toast.error((err as Error).message),
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
    onError: (err) => toast.error((err as Error).message),
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
    onError: (err) => toast.error((err as Error).message),
  });
}
