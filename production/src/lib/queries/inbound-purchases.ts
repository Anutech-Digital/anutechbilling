/**
 * Inbound purchases — Amazon & co. order emails staged for review (migration 0200).
 *
 * The webhook parses purchase emails into `inbound_purchases` (status 'pending').
 * The owner reviews them in the Purchase Inbox and either imports (→ a real
 * expense, human-in-loop so P&L/GST stay correct) or ignores.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { InboundPurchaseRow } from "@/lib/supabase/database.types";

export type InboundPurchase = InboundPurchaseRow;

/** List staged purchases for a status (default 'pending'), newest first. */
export function useInboundPurchases(status: "pending" | "imported" | "ignored" = "pending") {
  return useQuery({
    queryKey: ["inbound_purchases", status],
    queryFn: async (): Promise<InboundPurchase[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("inbound_purchases")
        .select("*")
        .eq("status", status)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as InboundPurchase[];
    },
  });
}

/** Count of pending purchases — drives the nav badge. */
export function usePendingPurchaseCount() {
  return useQuery({
    queryKey: ["inbound_purchases", "pending-count"],
    queryFn: async (): Promise<number> => {
      const supabase = createClient();
      const { count, error } = await supabase
        .from("inbound_purchases")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending");
      if (error) throw error;
      return count ?? 0;
    },
  });
}

function newExpenseId(): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand  = Math.floor(Math.random() * 256).toString(16).padStart(2, "0").toUpperCase();
  return `EXP-${stamp}-${rand}`;
}

/**
 * Import a staged purchase → a real expense (draft: paid=false, so it lands in
 * Expenses as payable/awaiting where the owner can edit or mark paid). The
 * amount stored is EX-GST (net = total − gst), matching how expenses hold value.
 */
export function useImportPurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (row: InboundPurchase): Promise<string> => {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not signed in");
      const { data: me, error: meErr } = await supabase
        .from("users").select("tenant_id").eq("id", authData.user.id).single();
      if (meErr || !me) throw new Error("User not linked to a tenant");

      const gross = Number(row.total) || 0;
      const gst   = Number(row.gst) || 0;
      const net   = Math.max(0, Math.round(gross - gst));
      const itemsSummary = (row.items ?? []).map((i) => `${i.qty}× ${i.name}`).join(", ").slice(0, 500);
      const description = [
        row.order_id ? `Amazon order ${row.order_id}` : "Amazon purchase",
        itemsSummary || null,
      ].filter(Boolean).join(" — ");

      const expenseId = newExpenseId();
      const { error } = await supabase.from("expenses").insert({
        id:            expenseId,
        tenant_id:     me.tenant_id,
        category:      "Office Supplies",
        vendor_name:   row.source === "amazon" ? "Amazon" : "Online purchase",
        currency:      row.currency || "INR",
        fx_rate:       1,
        bill_type:     gst > 0 ? "gst" : "none",
        bill_no:       row.order_id,
        expense_date:  row.order_date ?? new Date().toISOString().slice(0, 10),
        amount:        net,
        gst_paid:      Math.round(gst),
        paid:          false,
        description,
      });
      if (error) throw error;

      const { error: updErr } = await supabase
        .from("inbound_purchases")
        .update({ status: "imported", expense_id: expenseId })
        .eq("id", row.id);
      if (updErr) throw updErr;

      return expenseId;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inbound_purchases"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      toast.success("Added to expenses (draft) — review it in Expenses");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

/** Dismiss a staged purchase (not a real buy / duplicate). */
export function useIgnorePurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const supabase = createClient();
      const { error } = await supabase.from("inbound_purchases").update({ status: "ignored" }).eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inbound_purchases"] });
      toast.success("Ignored");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}
