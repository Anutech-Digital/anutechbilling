/**
 * Fixed asset register — reads/writes for lib/accounting/depreciation.ts.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import type { AssetBlock } from "@/lib/accounting/depreciation";

export interface FixedAsset {
  id: string;
  tenant_id: string;
  name: string;
  block: AssetBlock;
  cost: number;
  put_to_use: string;
  emi_purchase_id: string | null;
  expense_id: string | null;
  disposed_on: string | null;
  disposal_value: number;
  notes: string | null;
  created_at: string;
  /** R-1650: the expense it was capitalised from — the delete confirm says it returns to that
   *  month's P&L. Null when there is none or this login cannot read it. */
  source_expense: { amount: number; expense_date: string } | null;
}

const KEY = ["fixed-assets"] as const;

export function useFixedAssets() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<FixedAsset[]> => {
      const supabase = createClient();
      const { data, error } = await supabase.from("fixed_assets")
        .select("*, source_expense:expenses!fixed_assets_expense_id_fkey(amount, expense_date)")
        .order("put_to_use", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((a) => ({ ...a, block: a.block as AssetBlock, source_expense: a.source_expense ?? null }));
    },
    staleTime: 30_000,
  });
}

/** Equipment-category expenses that could be capitalised — offered in the add dialog. */
export function useCapitalisableExpenses() {
  return useQuery({
    queryKey: ["fixed-assets", "candidates"],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("expenses").select("id, vendor_name, description, amount, gst_paid, expense_date")
        .eq("category", "Equipment").order("expense_date", { ascending: false }).limit(50);
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 60_000,
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: KEY });
  qc.invalidateQueries({ queryKey: ["balance-sheet"] });
  /* R-1578: an asset changes the P&L too — its depreciation, and its expense leaves the costs. */
  qc.invalidateQueries({ queryKey: ["accounting", "pnl"] });
  qc.invalidateQueries({ queryKey: ["itr-pack"] });
}

export function useCreateFixedAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; block: AssetBlock; cost: number; putToUse: string; emiPurchaseId?: string | null; expenseId?: string | null; notes?: string | null }) => {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      const { data: me } = await supabase.from("users").select("tenant_id").eq("id", auth.user?.id ?? "").maybeSingle();
      if (!me?.tenant_id) throw new Error("Could not find your company — please sign in again.");
      const { error } = await supabase.from("fixed_assets").insert({
        tenant_id: me.tenant_id, name: input.name.trim(), block: input.block, cost: Math.round(input.cost), put_to_use: input.putToUse,
        emi_purchase_id: input.emiPurchaseId ?? null, expense_id: input.expenseId ?? null, notes: input.notes?.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => { invalidate(qc); toast.success("Added to the asset register"); },
    onError: (err) => toastError(err, { fallback: "Could not save the asset" }),
  });
}

export function useDisposeFixedAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; disposedOn: string | null; disposalValue: number }) => {
      const supabase = createClient();
      const { error } = await supabase.from("fixed_assets")
        .update({ disposed_on: input.disposedOn, disposal_value: Math.max(0, Math.round(input.disposalValue)), updated_at: new Date().toISOString() })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: (_d, i) => { invalidate(qc); toast.success(i.disposedOn ? "Asset marked sold / scrapped" : "Disposal removed"); },
    onError: (err) => toastError(err, { fallback: "Could not update" }),
  });
}

export function useDeleteFixedAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("fixed_assets").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { invalidate(qc); toast.success("Asset removed"); },
    onError: (err) => toastError(err, { fallback: "Could not delete" }),
  });
}
