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
import { toastError } from "@/lib/errors/toast-error";
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

/** Where the expense an order email became opens (Expenses page, edit dialog). */
export function expenseHref(expenseId: string): string {
  return `/accounting/expenses?edit=${encodeURIComponent(expenseId)}`;
}

export interface ImportPurchaseResult {
  /** The expense this order email is booked as (null only if that expense was deleted later). */
  expenseId: string | null;
  /** true = someone (or an earlier click) had already added it — nothing new was booked. */
  already: boolean;
}

/**
 * Import a staged purchase → a real expense (draft: paid=false, so it lands in
 * Expenses as payable/awaiting where the owner can edit or mark paid). The
 * amount stored is EX-GST (net = total − gst), matching how expenses hold value.
 *
 * R-2462: one atomic RPC (import_inbound_purchase) — it locks the order email, books the
 * expense and marks it imported in one transaction, and refuses sales/support. A second click,
 * a retry or a second person on the same email books nothing and answers `already: true`
 * with the same expense, which the toast offers to open.
 */
export function useImportPurchase(opts: { openHref?: (href: string) => void } = {}) {
  const qc = useQueryClient();
  const open = opts.openHref ?? ((href: string) => window.location.assign(href));
  return useMutation({
    mutationFn: async (row: Pick<InboundPurchase, "id">): Promise<ImportPurchaseResult> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("import_inbound_purchase", { p_id: row.id });
      if (error) throw error;
      const res = (data ?? {}) as { expense_id?: string | null; already?: boolean };
      return { expenseId: res.expense_id ?? null, already: res.already === true };
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["inbound_purchases"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      const action = res.expenseId
        ? { label: "Open it", onClick: () => open(expenseHref(res.expenseId as string)) }
        : undefined;
      if (res.already) {
        toast.info("Already added to expenses", {
          description: "Someone (or an earlier click) added this order already — nothing new was booked.",
          action,
        });
      } else {
        toast.success("Added to expenses (draft) — review it in Expenses", { action });
      }
    },
    onError: (err) => {
      qc.invalidateQueries({ queryKey: ["inbound_purchases"] });
      toastError(err);
    },
  });
}

/** Dismiss a staged purchase (not a real buy / duplicate). R-2462: through the guarded RPC. */
export function useIgnorePurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("set_inbound_purchase_status", { p_id: id, p_status: "ignored" });
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inbound_purchases"] });
      toast.success("Ignored");
    },
    onError: (err) => {
      qc.invalidateQueries({ queryKey: ["inbound_purchases"] });
      toastError(err);
    },
  });
}
